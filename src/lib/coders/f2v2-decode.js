// ═══════════════════════════════════════════════════
// F2V2 解码器 — ISOBMFF MP4 到文件流式提取
// CRAFT-2: stsz 前缀和 + co64 单条目定位, 无 indx
// ═══════════════════════════════════════════════════
//
// 解码流程:
//   1. parseMP4(blob) → { w, h, metaFrame, dataFrames, ... }
//   2. readFrame0V2(blob, metaFrame, password) → indexInfo
//   3. extractFileData / extractFileDataRange → 流式解密
//
// 与 CRAFT-1 的核心差异：
//   - sample 偏移 = co64[0] + stsz 前缀和（替代 00db header + indx）
//   - sample 内无 chunk header，数据区从 absOffset 直接开始
//   - dataFrames[i].fileDataSize = stsz[i]（无需减 8）
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

/** 读 4B ASCII tag */
function tagStr(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

// ═══════════════════════════════════════════════════
// ISOBMFF 容器解析
// ═══════════════════════════════════════════════════

/**
 * 读取 box header: { size, type, headerSize, dataStart, dataSize }
 * 处理 largesize (size=1 时后跟 8B 64-bit size)
 */
async function readBoxHeader(blob, off) {
  const hdr = await readBlob(blob, off, 16);
  if (hdr.length < 8) return null;

  const v = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
  let size = v.getUint32(0, false);       // BE
  const type = tagStr(hdr, 4);
  let headerSize = 8;

  if (size === 1) {
    // largesize: 后 8B 为 64-bit actual size
    if (hdr.length < 16) {
      const extra = await readBlob(blob, off + 8, 8);
      const ev = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
      size = Number(ev.getBigUint64(0, false));
      headerSize = 16;
    } else {
      size = Number(v.getBigUint64(8, false));
      headerSize = 16;
    }
  } else if (size === 0) {
    // extends to end of file
    size = blob.size - off;
  }

  return {
    size,
    type,
    headerSize,
    dataStart: off + headerSize,
    dataSize: size - headerSize,
    next: off + size,
  };
}

/**
 * 在 buffer 范围内按 box type 分发解析
 * 支持嵌套容器 box（trak, mdia, minf, stbl）
 */
async function walkBoxes(blob, start, end, handlers) {
  let off = start;
  while (off < end - 7) {
    const box = await readBoxHeader(blob, off);
    if (!box) break;

    const handler = handlers[box.type];
    if (handler) {
      const stop = await handler(blob, box);
      if (stop) break;
    }

    off = box.next;
    // 对齐到 8 字节（大部份 box 天然对齐，保守保护）
    if (off >= end) break;
  }
}

// ═══════════════════════════════════════════════════
// parseMP4: 解析 ISOBMFF MP4, 建立帧偏移表
// ═══════════════════════════════════════════════════

export async function parseMP4(blob) {
  // ftyp 验证
  const ftypHdr = await readBoxHeader(blob, 0);
  if (!ftypHdr || ftypHdr.type !== "ftyp") throw Error("不是 ISOBMFF 格式（ftyp 缺失）");

  let w = 0, h = 0;
  let stszEntries = null;        // [size0, size1, ...]
  let mdatBase = 0;              // co64[0]
  let sampleCount = 0;
  let mdatDataStart = 0;

  // 遍历顶层 box
  let off = ftypHdr.next;
  while (off < blob.size - 7) {
    const box = await readBoxHeader(blob, off);
    if (!box) break;

    if (box.type === "moov") {
      // 在 trak → mdia → minf → stbl 中查找 stsd, stsz, co64
      // trak
      await walkBoxes(blob, box.dataStart, box.dataStart + box.dataSize, {
        trak: async (blob, trak) => {
          await walkBoxes(blob, trak.dataStart, trak.dataStart + trak.dataSize, {
            tkhd: async (blob, tkhd) => {
              const buf = await readBlob(blob, tkhd.dataStart, 92 - 8);
              if (buf.length >= 84) {
                const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                w = v.getUint32(76, false) >>> 16;
                h = v.getUint32(80, false) >>> 16;
              }
            },
            mdia: async (blob, mdia) => {
              await walkBoxes(blob, mdia.dataStart, mdia.dataStart + mdia.dataSize, {
                minf: async (blob, minf) => {
                  await walkBoxes(blob, minf.dataStart, minf.dataStart + minf.dataSize, {
                    stbl: async (blob, stbl) => {
                      await walkBoxes(blob, stbl.dataStart, stbl.dataStart + stbl.dataSize, {
                        stsd: async (blob, stsd) => {
                          const buf = await readBlob(blob, stsd.dataStart, 102 - 8);
                          if (buf.length >= 44) {
                            const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                            w = v.getUint16(40, false);
                            h = v.getUint16(42, false);
                          }
                        },
                        stsz: async (blob, stszBox) => {
                          const hdr = await readBlob(blob, stszBox.dataStart, 12);
                          const v = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
                          // v.getUint32(4, false) = sample_size (0 = variable)
                          // v.getUint32(8, false) = sample_count
                          sampleCount = v.getUint32(8, false);
                          const entryData = await readBlob(
                            blob,
                            stszBox.dataStart + 12,
                            sampleCount * 4,
                          );
                          const ev = new DataView(entryData.buffer, entryData.byteOffset, entryData.byteLength);
                          stszEntries = [];
                          for (let i = 0; i < sampleCount; i++) {
                            stszEntries.push(ev.getUint32(i * 4, false));
                          }
                        },
                        co64: async (blob, co64Box) => {
                          // co64 数据: version(1)+flags(3)+entry_count(4)+entry[0].offset(8) = 16B
                          const buf = await readBlob(blob, co64Box.dataStart, 16);
                          const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                          const entryCount = v.getUint32(4, false);
                          if (entryCount < 1) return;
                          mdatBase = Number(v.getBigUint64(8, false));
                        },
                      });
                    },
                  });
                },
              });
            },
          });
        },
      });
    } else if (box.type === "mdat") {
      mdatDataStart = box.dataStart;
    }

    off = box.next;
  }

  if (!stszEntries || stszEntries.length === 0) throw Error("stsz 为空");
  if (!w || !h) throw Error("未解析到分辨率");
  if (!mdatBase) throw Error("co64 缺失");

  // 一致性检查：co64 应指向 mdat 数据区
  if (mdatBase !== mdatDataStart) {
    throw Error(
      "co64 offset (" + mdatBase + ") ≠ mdat data start (" + mdatDataStart + ")",
    );
  }

  // 构建帧偏移表（stsz 前缀和，64-bit 安全）
  // sample[i] 的绝对文件偏移 = mdatBase + Σ_{j<0) stsz[j]
  const sampleOffsets = [];       // BigInt for accurate large offsets
  let prefix = BigInt(mdatBase);
  for (let i = 0; i < stszEntries.length; i++) {
    sampleOffsets.push(Number(prefix));
    prefix += BigInt(stszEntries[i]);
  }

  // 分离帧 0 和数据帧
  const metaFrame = {
    frameID: 0,
    absOffset: sampleOffsets[0],
    size: stszEntries[0],
  };

  const dataFrames = [];
  let fileDataOff = 0;
  for (let i = 1; i < stszEntries.length; i++) {
    const f = {
      frameID: i,
      absOffset: sampleOffsets[i],
      size: stszEntries[i],
      fileDataSize: stszEntries[i],  // 直接就是数据大小，无需减 8
      fileStart: fileDataOff,
      fileEnd: fileDataOff + stszEntries[i],
    };
    dataFrames.push(f);
    fileDataOff += stszEntries[i];
  }

  return {
    w,
    h,
    metaFrame,
    dataFrames,
    totalFileData: fileDataOff,
    sampleCount,
    mdatBase,
  };
}

// ═══════════════════════════════════════════════════
// 帧 0 读取 + 解密
// ═══════════════════════════════════════════════════

export async function readFrame0V2(blob, metaFrame, password) {
  // 直接读 sample 数据（无 8B AVI chunk header）
  const buf = await readBlob(blob, metaFrame.absOffset, metaFrame.size);
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

  // 验证密码
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
    entriesEnd,   // 加密区中元数据结束偏移（用于累计加密字节数）
  };
}

// ═══════════════════════════════════════════════════
// 文件数据提取（AES-CTR 对齐解密）
// ═══════════════════════════════════════════════════

/**
 * 从 dataFrames 中提取指定范围，AES-CTR 对齐后解密
 * 帧间 counter 连续接续，帧内从 blockOff/prePad 对齐
 */
async function decryptFromFramesV2(
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

    // 直接读 sample 数据（无 8B chunk header）
    const readOff = f.absOffset + localStart - prePad;
    let encrypted = await readBlob(blob, readOff, alignedLen);

    // 末帧对齐：编码时只写了实际数据，未写 AES 块对齐填充字节
    // 解码端需补零到 alignedLen，模拟编码时的 padded 缓冲区
    const truncated = encrypted.length < alignedLen;
    if (truncated) {
      const padded = new Uint8Array(alignedLen);
      padded.set(encrypted, 0);
      encrypted = padded;
    }

    const decrypted = await aesDecrypt(encrypted, key, frameSalt, blockOff, 128);
    const slice = decrypted.subarray(prePad, prePad + len);
    result.set(slice, written);
    written += slice.length;
    cumulativeEncrypted += f.fileDataSize;

    if (truncated) break;
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
  return decryptFromFramesV2(
    blob, dataFrames, indexInfo.key, indexInfo.frameSalt,
    indexInfo, entry.globalOffset, entry.size,
  );
}

/**
 * 提取单个文件的指定范围（流式下载用）
 */
export async function extractFileDataRange(
  blob, indexInfo, dataFrames, fileIdx,
  rangeStart, rangeLen,
) {
  const entry = indexInfo.entries[fileIdx];
  if (!entry) throw Error("文件索引无效: " + fileIdx);

  if (rangeStart == null)
    return extractFileData(blob, indexInfo, dataFrames, fileIdx);
  const fileEnd = entry.globalOffset + entry.size;
  const readStart = entry.globalOffset + rangeStart;
  const readLen = Math.min(rangeLen || 0, fileEnd - readStart);
  return decryptFromFramesV2(
    blob, dataFrames, indexInfo.key, indexInfo.frameSalt,
    indexInfo, readStart, readLen,
  );
}

/**
 * 构建流式 ReadableStream 用于下载单个文件
 */
export function buildDecodeStream(
  blob, indexInfo, dataFrames, fileIdx, chunkSizeKB,
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
            blob, indexInfo, dataFrames, fileIdx, offset, take,
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
