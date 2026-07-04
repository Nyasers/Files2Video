// ═══════════════════════════════════════════════════
// F2V 解码器 — AVI 到文件流式提取
// ═══════════════════════════════════════════════════
//
// 解码流程 (CRAFT-1):
//   1. parseAVI(blob) → { w, h, fps, frames, metaFrame, dataFrames }
//   2. readFrame0(blob, metaFrame, password) → indexInfo
//   3. extractFileData / extractFileDataRange → 流式解密
//
// frames[0] 为元数据帧（含 28B 明文头 + 加密 fileEntries）
// frames[1..N] 为数据帧（0B 帧头，纯加密文件数据）
//
// ═══════════════════════════════════════════════════
"use strict";

import {
  deriveEncKey,
  aesDecrypt,
  parseFileEntries,
  FRAME0_HEADER_SIZE,
  F2V1,
} from "../f2v-core.js";

// ── Blob 读取 ──

async function readBlob(blob, start, length) {
  if (length <= 0) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

// ── 4 字节比较 ──

function tagEq(buf, off, a, b, c, d) {
  return (
    buf[off] === a &&
    buf[off + 1] === b &&
    buf[off + 2] === c &&
    buf[off + 3] === d
  );
}

// ═══════════════════════════════════════════════════
// AVI 容器解析
// ═══════════════════════════════════════════════════

export async function parseAVI(blob) {
  // RIFF 验证
  let buf = await readBlob(blob, 0, 12);
  if (buf.length < 12) throw Error("文件过短");
  if (!tagEq(buf, 0, 0x52, 0x49, 0x46, 0x46)) throw Error("不是 RIFF 格式");
  if (!tagEq(buf, 8, 0x41, 0x56, 0x49, 0x20)) throw Error("不是 AVI 格式");

  let off = 12;
  let w = 0,
    h = 0,
    fps = 30;
  let moviStart = 0;
  const rawFrames = []; // { absOffset, size }

  while (off < blob.size - 8) {
    buf = await readBlob(blob, off, 8);
    if (buf.length < 8) break;
    const v = new DataView(buf.buffer);
    const id = v.getUint32(0, true);
    const size = v.getUint32(4, true);
    off += 8;

    if (id === 0x5453494c) {
      // 'LIST'
      const ft = await readBlob(blob, off, 4);
      if (ft.length < 4) break;

      if (tagEq(ft, 0, 0x68, 0x64, 0x72, 0x6c)) {
        // 'hdrl'
        const end = off + size;
        off += 4;
        while (off < end) {
          buf = await readBlob(blob, off, 8);
          if (buf.length < 8) break;
          const cid = new DataView(buf.buffer).getUint32(0, true);
          const csz = new DataView(buf.buffer).getUint32(4, true);
          off += 8;

          if (cid === 0x68697661) {
            // 'avih'
            const ah = await readBlob(blob, off, 56);
            fps = Math.round(
              1000000 / new DataView(ah.buffer).getUint32(0, true),
            );
            off += csz;
          } else if (cid === 0x5453494c) {
            // 'LIST' (strl)
            off += 4;
            const strlEnd = off + csz - 4;
            while (off < strlEnd) {
              buf = await readBlob(blob, off, 8);
              const scid = new DataView(buf.buffer).getUint32(0, true);
              const scsz = new DataView(buf.buffer).getUint32(4, true);
              off += 8;
              if (scid === 0x66727473) {
                // 'strf'
                const sf = await readBlob(blob, off, 40);
                const sfv = new DataView(sf.buffer);
                w = sfv.getUint32(4, true);
                h = sfv.getUint32(8, true);
                off += scsz;
              } else {
                off += scsz;
              }
              if (scsz % 2 !== 0) off++;
            }
          } else {
            off += csz;
          }
          if (csz % 2 !== 0) off++;
        }
      } else if (tagEq(ft, 0, 0x6d, 0x6f, 0x76, 0x69)) {
        // 'movi'
        moviStart = off + 4; // movi data 起始
        off += size; // 跳过 form type(4) + data(size-4) = 整个 size 字节
      } else {
        off += size;
      }
    } else if (id === 0x78646e69) {
      // 'indx'
      // 标准 AVISTDINDEX: 24B sub-header + entries
      const subHdr = await readBlob(blob, off, 24);
      const shv = new DataView(subHdr.buffer);
      const nEntries = shv.getUint32(4, true); // nEntriesInUse at offset 4 from sub-header base
      const entryCount = Math.min(nEntries, Math.floor((size - 24) / 24));
      const idxBuf = await readBlob(blob, off + 24, entryCount * 24);
      const iv = new DataView(idxBuf.buffer);
      for (let i = 0; i < entryCount; i++) {
        const base = i * 24;
        const foff = iv.getUint32(base + 8, true); // movi-relative
        const dsz = iv.getUint32(base + 16, true); // dataSize（不含 chunk header）
        rawFrames.push({ frameID: i, absOffset: moviStart + foff, size: dsz + 8 }); // 转为 chunkSize
      }
      off += size;
    } else {
      off += size;
    }
    if (size % 2 !== 0) off++;
  }

  if (!moviStart) throw Error("未找到 movi LIST");
  if (!rawFrames.length) throw Error("indx 为空");
  if (!w || !h) throw Error("未解析到分辨率");

  // 分离元数据帧和数据帧
  const metaFrame = rawFrames[0];
  const dataFrames = rawFrames.slice(1);

  // 为数据帧标记文件数据偏移 (相对于文件数据起始的偏移)
  let fileDataOff = 0;
  for (const f of dataFrames) {
    f.fileDataSize = f.size - 8; // 减去 00db header
    f.fileStart = fileDataOff;
    f.fileEnd = fileDataOff + f.fileDataSize;
    fileDataOff += f.fileDataSize;
  }
  const totalFileData = fileDataOff;

  return {
    w,
    h,
    fps,
    metaFrame,
    dataFrames,
    totalFileData,
    rawFrames,
  };
}

// ═══════════════════════════════════════════════════
// 帧 0 读取 + 解密
// ═══════════════════════════════════════════════════

export async function readFrame0(blob, metaFrame, password) {
  const buf = await readBlob(blob, metaFrame.absOffset + 8, metaFrame.size - 8);
  if (buf.length < FRAME0_HEADER_SIZE) throw Error("帧 0 数据不足");

  // 明文头
  let magic = 0;
  for (let i = 0; i < 4; i++) magic = (magic << 8) | buf[i];
  if (magic !== F2V1) throw Error("不是 F2V1 格式");

  const encMagic = buf.subarray(4, 8);
  const frameSalt = buf.subarray(8, 24);
  let iter = 0;
  for (let i = 0; i < 4; i++) iter = (iter << 8) | buf[24 + i];

  const key = await deriveEncKey(password, frameSalt, iter, true);

  // 验证
  const md = await aesDecrypt(encMagic, key, frameSalt, 0, 128);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x56 || md[3] !== 0x31)
    throw Error("密码错误");

  // 解密加密区
  const encArea = buf.subarray(FRAME0_HEADER_SIZE);
  const decrypted = await aesDecrypt(encArea, key, frameSalt, 1, 128);

  // 解析 fileCount + fileEntries
  let fileCount = 0;
  for (let i = 0; i < 8; i++) fileCount = (fileCount << 8) | decrypted[i];

  const { entries, entriesEnd } = parseFileEntries(decrypted, 8, fileCount);

  // 全局偏移表
  let acc = 0;
  for (const e of entries) {
    e.globalOffset = acc;
    acc += e.size;
  }

  return {
    entries,
    key,
    frameSalt,
    iter,
    fileCount,
    entriesEnd, // 加密区中元数据结束偏移 (用于累计加密字节)
  };
}

// ═══════════════════════════════════════════════════
// 文件数据提取
// ═══════════════════════════════════════════════════

/**
 * 从帧列表中提取指定文件数据范围的 AES-CTR 对齐解密
 * 帧 0 之后的每一帧连续接续 AES-CTR 流
 */
async function decryptFromFrames(
  blob,
  dataFrames,
  key,
  frameSalt,
  indexInfo,
  rangeStart,
  rangeLen,
) {
  if (rangeLen <= 0) return new Uint8Array(0);

  const result = new Uint8Array(rangeLen);
  let written = 0;
  let cumulativeEncrypted = indexInfo.entriesEnd;

  for (const f of dataFrames) {
    if (written >= rangeLen) break;
    if (rangeStart >= f.fileEnd) {
      cumulativeEncrypted += f.fileDataSize;
      continue;
    }
    if (rangeStart + rangeLen <= f.fileStart) break;

    const rs = Math.max(rangeStart, f.fileStart);
    const re = Math.min(rangeStart + rangeLen, f.fileEnd);
    const len = re - rs;
    const localStart = rs - f.fileStart;

    const streamOffset = cumulativeEncrypted + localStart;
    const blockOff = 1 + Math.floor(streamOffset / 16);
    const prePad = streamOffset % 16;
    const alignedLen = Math.ceil((prePad + len) / 16) * 16;

    // 从 blob 读对齐后的加密数据
    const readOff = f.absOffset + 8 + localStart - prePad;
    const encrypted = await readBlob(blob, readOff, alignedLen);
    if (encrypted.length < alignedLen) break;

    const decrypted = await aesDecrypt(
      encrypted,
      key,
      frameSalt,
      blockOff,
      128,
    );
    const slice = decrypted.subarray(prePad, prePad + len);
    result.set(slice, written);
    written += slice.length;
    cumulativeEncrypted += f.fileDataSize;
  }

  return written < rangeLen ? result.subarray(0, written) : result;
}

/**
 * 提取单个文件的完整解密数据
 */
export async function extractFileData(blob, indexInfo, dataFrames, fileIdx) {
  const entry = indexInfo.entries[fileIdx];
  if (!entry) throw Error("文件索引无效: " + fileIdx);
  if (entry.size === 0) return new Uint8Array(0);
  return decryptFromFrames(
    blob,
    dataFrames,
    indexInfo.key,
    indexInfo.frameSalt,
    indexInfo,
    entry.globalOffset,
    entry.size,
  );
}

/**
 * 提取单个文件的指定范围（流式下载用）
 */
export async function extractFileDataRange(
  blob,
  indexInfo,
  dataFrames,
  fileIdx,
  rangeStart,
  rangeLen,
) {
  const entry = indexInfo.entries[fileIdx];
  if (!entry) throw Error("文件索引无效: " + fileIdx);

  if (rangeStart == null)
    return extractFileData(blob, indexInfo, dataFrames, fileIdx);
  const fileEnd = entry.globalOffset + entry.size;
  const readStart = entry.globalOffset + rangeStart;
  const readLen = Math.min(rangeLen || 0, fileEnd - readStart);
  return decryptFromFrames(
    blob,
    dataFrames,
    indexInfo.key,
    indexInfo.frameSalt,
    indexInfo,
    readStart,
    readLen,
  );
}

/**
 * 构建流式 ReadableStream 用于下载单个文件
 */
export function buildDecodeStream(
  blob,
  indexInfo,
  dataFrames,
  fileIdx,
  chunkSizeKB,
) {
  const entry = indexInfo.entries[fileIdx];
  if (!entry) throw Error("文件索引无效: " + fileIdx);

  const fileSize = entry.size;
  const CHUNK = (chunkSizeKB || 64) * 1024;

  const job = { cancelled: false, progress: 0 };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let offset = 0;
        while (offset < fileSize && !job.cancelled) {
          const take = Math.min(CHUNK, fileSize - offset);
          const chunk = await extractFileDataRange(
            blob,
            indexInfo,
            dataFrames,
            fileIdx,
            offset,
            take,
          );
          if (job.cancelled || chunk.length === 0) break;
          controller.enqueue(chunk);
          offset += chunk.length;
        }
        if (!job.cancelled) controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      job.cancelled = true;
    },
  });

  return { stream, fileSize, fileName: entry.name, job };
}
