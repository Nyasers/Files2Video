// ═══════════════════════════════════════════════
// F2V 核心库 — 页面 + SW 共用
// 常量 · 加密工具 · AVI 流式构建 · 预计算
// ═══════════════════════════════════════════════
"use strict";

const _ctx = { e: new TextEncoder() };

// ── 魔数 ──

export const F2V1 = 0x46325631; // "F2V1"

// ── 帧头常量 ──

export const FRAME0_HEADER_SIZE = 28; // magic(4) + encMagic(4) + frameSalt(16) + iter(4)
export const BPP = 4; // 32-bit BGRA
export const ITER_DEFAULT = 10000;

// ── AVI 常量 ──

const AVIIF_KEYFRAME = 0x00000010;
const AVIF_HASINDEX = 0x00000010;
const AVIF_MUSTUSEINDEX = 0x00010000;

// ═══════════════════════════════════════════════
// 尺寸格式化
// ═══════════════════════════════════════════════

export function fmt(b) {
  return b < 1024
    ? b + " B"
    : b < 1048576
      ? (b / 1024).toFixed(1) + " KB"
      : b < 1073741824
        ? (b / 1048576).toFixed(2) + " MB"
        : b < 1099511627776
          ? (b / 1073741824).toFixed(2) + " GB"
          : (b / 1099511627776).toFixed(2) + " TB";
}

// ═══════════════════════════════════════════════
// 加密工具（从 f2p-core.js 移植，魔数改为 F2V1）
// ═══════════════════════════════════════════════

export async function deriveEncKey(password, salt, iterations, extractable) {
  const pwdKey = await crypto.subtle.importKey(
    "raw",
    _ctx.e.encode(password || ""),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: iterations || ITER_DEFAULT,
      hash: "SHA-256",
    },
    pwdKey,
    { name: "AES-CTR", length: 256 },
    !!extractable,
    ["encrypt", "decrypt"],
  );
}

function buildCtr(counter, blockOff, bits) {
  const ctr = new Uint8Array(16);
  ctr.set(counter, 0);
  const cBits = Math.max(1, Math.min(128, bits || 128));
  const cBytes = Math.ceil(cBits / 8);
  let val = 0n;
  const start = 16 - cBytes;
  for (let i = start; i < 16; i++) val = (val << 8n) | BigInt(ctr[i]);
  val += BigInt(Math.trunc(blockOff));
  if (cBits < 128) {
    const mask = (1n << BigInt(cBits)) - 1n;
    val &= mask;
  }
  for (let i = 15; i >= start; i--) {
    ctr[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  if (cBits < 128) {
    const partialBits = cBits % 8;
    if (partialBits !== 0) {
      const mask = (1 << partialBits) - 1;
      ctr[start] = (counter[start] & ~mask) | (ctr[start] & mask);
    }
  }
  return ctr;
}

export async function aesEncrypt(plain, key, counter, blockOff, bits) {
  const nb = Math.max(1, Math.min(128, bits || 128));
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: buildCtr(counter, blockOff, nb), length: nb },
      key,
      plain,
    ),
  );
}

export async function aesDecrypt(data, key, counter, blockOff, bits) {
  const nb = Math.max(1, Math.min(128, bits || 128));
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: buildCtr(counter, blockOff, nb), length: nb },
      key,
      data,
    ),
  );
}

// ═══════════════════════════════════════════════
// 文件读取（流式 chunk）
// ═══════════════════════════════════════════════

export async function readChunk(file, start, end, trySize) {
  const TIMEOUT = 60000;
  try {
    const blob = await file.slice(start, end);
    // 用 arrayBuffer 一次性读完，避免 Blob.stream() 多 chunk 漏数据
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    const half = Math.max(trySize >>> 1, 1024);
    if (half < trySize && start + half < end) {
      const a = await readChunk(file, start, start + half, half);
      const b = await readChunk(file, start + half, end, half);
      const mg = new Uint8Array(a.length + b.length);
      mg.set(a);
      mg.set(b, a.length);
      return mg;
    }
    throw new Error("读取文件失败 @" + start + "-" + end);
  }
}

/**
 * 从多个文件中按全局偏移读取数据
 */
export async function readFileDataRange(files, offset, length) {
  let cum = 0;
  const parts = [];
  let remaining = length;
  for (const f of files) {
    if (remaining <= 0) break;
    if (offset >= cum + f.size) {
      cum += f.size;
      continue;
    }
    const fileStart = Math.max(0, offset - cum);
    const readLen = Math.min(f.size - fileStart, remaining);
    const buf = await readChunk(f, fileStart, fileStart + readLen, readLen);
    parts.push(buf);
    remaining -= readLen;
    offset += readLen;
    cum += f.size;
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}

// ═══════════════════════════════════════════════
// 数据写入工具（流式 push）
// ═══════════════════════════════════════════════

export function createWriter(push) {
  return {
    w16(v) {
      push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
    },
    w32(v) {
      push(
        new Uint8Array([
          v & 0xff,
          (v >>> 8) & 0xff,
          (v >>> 16) & 0xff,
          (v >>> 24) & 0xff,
        ]),
      );
    },
    w32BE(v) {
      push(
        new Uint8Array([
          (v >>> 24) & 0xff,
          (v >>> 16) & 0xff,
          (v >>> 8) & 0xff,
          v & 0xff,
        ]),
      );
    },
    w64BE(v) {
      const hi = Math.floor(v / 0x100000000) >>> 0;
      const lo = v >>> 0;
      push(
        new Uint8Array([
          (hi >>> 24) & 0xff,
          (hi >>> 16) & 0xff,
          (hi >>> 8) & 0xff,
          hi & 0xff,
          (lo >>> 24) & 0xff,
          (lo >>> 16) & 0xff,
          (lo >>> 8) & 0xff,
          lo & 0xff,
        ]),
      );
    },
    wBytes(arr) {
      push(arr);
    },
    wStr4(s) {
      const buf = new Uint8Array(4);
      for (let i = 0; i < 4; i++)
        buf[i] = i < s.length ? s.charCodeAt(i) : 0x20;
      push(buf);
    },
    wPadZeros(n) {
      if (n > 0) push(new Uint8Array(n));
    },
  };
}

// ═══════════════════════════════════════════════
// 预计算
// ═══════════════════════════════════════════════

/**
 * 预计算帧布局
 * 帧 0 纯元数据，帧 1..N 纯文件数据
 */
export function precomputeFrames(files, w, h) {
  let fileListSize = 0;
  const nameBufs = [];
  for (const f of files) {
    const nb = new TextEncoder().encode(f.name);
    nameBufs.push(nb);
    fileListSize += 2 + 8 + nb.length;
  }

  const fileTotalData = files.reduce((s, f) => s + f.size, 0);
  const bytesPerFrame = w * h * BPP;

  // 帧 0 纯元数据
  const frame0EncData = 8 + fileListSize; // fileCount + fileEntries

  // 元数据超限检查
  if (frame0EncData > bytesPerFrame - FRAME0_HEADER_SIZE) {
    throw new Error(
      "文件列表容量不足：至少需要 " +
        fmt(frame0EncData + FRAME0_HEADER_SIZE) +
        " / 帧，当前 " +
        fmt(bytesPerFrame) +
        " / 帧",
    );
  }

  // 数据帧
  const dataPerFrame = bytesPerFrame;
  const dataFrameCount =
    fileTotalData > 0 ? Math.ceil(fileTotalData / dataPerFrame) : 0;
  const totalFrames = 1 + dataFrameCount;

  // 帧数据分配
  const frames = [];
  let dataOff = 0;

  frames.push({
    frameID: 0,
    isMeta: true,
    encStart: FRAME0_HEADER_SIZE,
    dataSize: frame0EncData,
    chunkSize: 8 + FRAME0_HEADER_SIZE + frame0EncData,
    dataOffset: 0,
  });
  // 注意：帧 0 元数据不占用 file data 的 offset 空间
  // dataOff 保持 0，后续数据帧从文件头开始读

  for (let i = 1; i < totalFrames; i++) {
    const rem = fileTotalData - (i - 1) * dataPerFrame;
    const ds = Math.min(rem, dataPerFrame);
    frames.push({
      frameID: i,
      isMeta: false,
      encStart: 0,
      dataSize: ds,
      chunkSize: 8 + ds,
      dataOffset: dataOff,
    });
    dataOff += ds;
  }

  return {
    totalFrames,
    fileListSize,
    fileTotalData,
    frames,
    nameBufs,
    bytesPerFrame,
    fileCount: files.length,
  };
}

/**
 * CRAFT-2 帧布局：帧结构不变，但 sampleSize 不含 AVI chunk 头
 * 帧 0 sample = FRAME0_HEADER_SIZE + frame0EncData
 * 数据帧 sample = dataSize (无 8B header, 无 WORD 对齐)
 */
export function precomputeFramesV2(files, w, h) {
  let fileListSize = 0;
  const nameBufs = [];
  for (const f of files) {
    const nb = new TextEncoder().encode(f.name);
    nameBufs.push(nb);
    fileListSize += 2 + 8 + nb.length;
  }

  const fileTotalData = files.reduce((s, f) => s + f.size, 0);
  const bytesPerFrame = w * h * BPP;

  const frame0EncData = 8 + fileListSize;

  if (frame0EncData > bytesPerFrame - FRAME0_HEADER_SIZE) {
    throw new Error(
      "文件列表容量不足：至少需要 " +
        (FRAME0_HEADER_SIZE + frame0EncData) +
        " / 帧，当前 " +
        bytesPerFrame +
        " / 帧",
    );
  }

  const dataPerFrame = bytesPerFrame;
  const dataFrameCount =
    fileTotalData > 0 ? Math.ceil(fileTotalData / dataPerFrame) : 0;
  const totalFrames = 1 + dataFrameCount;

  const frames = [];
  let dataOff = 0;

  frames.push({
    frameID: 0,
    isMeta: true,
    encStart: FRAME0_HEADER_SIZE,
    dataSize: frame0EncData,
    sampleSize: FRAME0_HEADER_SIZE + frame0EncData,
    dataOffset: 0,
  });

  for (let i = 1; i < totalFrames; i++) {
    const rem = fileTotalData - (i - 1) * dataPerFrame;
    const ds = Math.min(rem, dataPerFrame);
    frames.push({
      frameID: i,
      isMeta: false,
      encStart: 0,
      dataSize: ds,
      sampleSize: ds,
      dataOffset: dataOff,
    });
    dataOff += ds;
  }

  return {
    totalFrames,
    fileListSize,
    fileTotalData,
    frames,
    nameBufs,
    bytesPerFrame,
    fileCount: files.length,
  };
}

// ═══════════════════════════════════════════════
// AVI 索引表构建
// ═══════════════════════════════════════════════

/**
 * 构建 AVI 索引表和头部大小
 * 所有数值在写入前确定，不依赖回填
 */
export function buildAVIIndex(frameInfo, fps) {
  const { frames, totalFrames } = frameInfo;

  // avih
  const avihSize = 8 + 56;
  const strhSize = 8 + 64; // strh data = 64B (12xDWORD + RECT 4xLONG)
  const strfSize = 8 + 40;
  const dmlhSize = 8 + 4; // 'dmlh' + size + dwTotalFrames
  const superIndxSize = 8 + 24 + 1 * 16; // RIFF header + sub-header + 1 entry
  const strlListSize = 8 + 4 + strhSize + strfSize + superIndxSize;
  const hdrlListSize = 8 + 4 + avihSize + dmlhSize + strlListSize;

  // 帧数据大小（含每帧 WORD 对齐填充）
  let frameDataSize = 0;
  for (const f of frames) {
    frameDataSize += f.chunkSize;
    if (f.chunkSize % 2 !== 0) frameDataSize++;
  }

  // ix00（Standard Index：sub-header 24B + 8B/entry，放在 movi 内）
  const STD_SUB_SIZE = 24;
  const STD_ENTRY_SIZE = 8;
  const stdChunkDataSize = STD_SUB_SIZE + totalFrames * STD_ENTRY_SIZE;
  const stdIndxSize = 8 + stdChunkDataSize;

  // movi size = 帧数据 + WORD 对齐 + ix00 索引（均在 movi LIST 内）
  const moviPad = frameDataSize % 2 !== 0;
  const moviDataSize = frameDataSize + (moviPad ? 1 : 0) + stdIndxSize;
  const moviListSize = 8 + 4 + moviDataSize;

  // RIFF header
  const riffDataSize = 4 + hdrlListSize + moviListSize;
  const totalFileSize = 12 + hdrlListSize + moviListSize;

  // movi 数据区起始偏移
  const moviStart = 12 + hdrlListSize + 8 + 4;

  // 累计帧偏移
  let currOff = 0;
  const frameOffsets = [];
  for (let i = 0; i < totalFrames; i++) {
    frameOffsets.push(currOff);
    currOff += frames[i].chunkSize;
    if (frames[i].chunkSize % 2 !== 0) currOff++;
  }

  // ── ix00（Standard Index，放在 movi 尾部） ──
  const ix00Buf = new Uint8Array(8 + stdChunkDataSize);
  const ix = new DataView(ix00Buf.buffer);
  ix.setUint32(0, 0x30307869, true); // 'ix00'
  ix.setUint32(4, stdChunkDataSize, true);
  ix.setUint16(8, 2, true); // wLongsPerEntry = 2
  ix.setUint8(10, 0); // bIndexSubType
  ix.setUint8(11, 1); // bIndexType = AVI_INDEX_OF_CHUNKS
  ix.setUint32(12, totalFrames, true); // nEntriesInUse
  ix.setUint32(16, 0x62643030, true); // dwChunkId = '00db'
  // qwBaseOffset = moviStart（绝对文件偏移）
  const baseHi = Math.floor(moviStart / 0x100000000) >>> 0;
  const baseLo = moviStart >>> 0;
  ix.setUint32(20, baseLo, true); // qwBaseOffset low
  ix.setUint32(24, baseHi, true); // qwBaseOffset high
  ix.setUint32(28, 0, true); // dwReserved3
  // entries
  for (let i = 0; i < totalFrames; i++) {
    const base = 32 + i * STD_ENTRY_SIZE;
    ix.setUint32(base, frameOffsets[i], true); // dwOffset（相对 qwBaseOffset）
    ix.setUint32(base + 4, frames[i].chunkSize - 8, true); // dwSize = dataSize
  }

  // ── dmlh（OpenDML 扩展头） ──
  const dmlhBuf = new Uint8Array(12);
  const dm = new DataView(dmlhBuf.buffer);
  dm.setUint32(0, 0x686c6d64, true); // 'dmlh'
  dm.setUint32(4, 4, true);
  dm.setUint32(8, totalFrames, true);

  // ── Super Index（AVI_INDEX_OF_INDEXES，放 strl 内） ──
  // ix00 在 movi 内部：帧数据之后 + WORD 对齐之后
  const ix00Off = moviStart + frameDataSize + (moviPad ? 1 : 0);
  const SUP_SUB_SIZE = 24;
  const SUP_ENTRY_SIZE = 16;
  const supDataSize = SUP_SUB_SIZE + 1 * SUP_ENTRY_SIZE;
  const superIndxBuf = new Uint8Array(8 + supDataSize);
  const si = new DataView(superIndxBuf.buffer);
  si.setUint32(0, 0x78646e69, true); // 'indx'
  si.setUint32(4, supDataSize, true);
  si.setUint16(8, 4, true); // wLongsPerEntry = 4
  si.setUint8(10, 0); // bIndexSubType
  si.setUint8(11, 0); // bIndexType = AVI_INDEX_OF_INDEXES
  si.setUint32(12, 1, true); // nEntriesInUse = 1
  si.setUint32(16, 0x62643030, true); // dwChunkId = '00db'
  // dwReserved[3] 默认 0
  // entry: qwOffset + dwSize + dwDuration
  const hi = Math.floor(ix00Off / 0x100000000) >>> 0;
  const lo = ix00Off >>> 0;
  si.setUint32(32, lo, true); // qwOffset low
  si.setUint32(36, hi, true); // qwOffset high
  si.setUint32(40, stdIndxSize, true); // ix00 chunk size
  si.setUint32(44, totalFrames, true); // dwDuration

  return {
    totalFileSize,
    moviStart,
    moviListSize,
    hdrlListSize,
    ix00Buf,
    stdIndxSize,
    dmlhBuf,
    superIndxBuf,
    riffDataSize,
    moviPad,
  };
}

// ═══════════════════════════════════════════════
// AVI 头写入（流式 push）
// ═══════════════════════════════════════════════

export function writeAVIHeader(push, aviIndex, w, h, fps, totalFrames) {
  const wtr = createWriter(push);
  const { totalFileSize, hdrlListSize, moviListSize, riffDataSize } = aviIndex;

  // RIFF
  wtr.wStr4("RIFF");
  wtr.w32(riffDataSize);
  wtr.wStr4("AVI ");

  // LIST hdrl
  wtr.wStr4("LIST");
  wtr.w32(hdrlListSize - 8);
  wtr.wStr4("hdrl");

  // avih
  wtr.wStr4("avih");
  wtr.w32(56);
  wtr.w32(Math.round(1000000 / fps)); // dwMicroSecPerFrame
  wtr.w32(0); // dwMaxBytesPerSec
  wtr.w32(0); // dwPaddingGranularity
  wtr.w32(AVIF_HASINDEX | AVIF_MUSTUSEINDEX); // dwFlags
  wtr.w32(totalFrames); // dwTotalFrames
  wtr.w32(0); // dwInitialFrames
  wtr.w32(1); // dwStreams
  wtr.w32(0); // dwSuggestedBufferSize
  wtr.w32(w); // dwWidth
  wtr.w32(h); // dwHeight
  wtr.w32(0);
  wtr.w32(0);
  wtr.w32(0);
  wtr.w32(0); // reserved

  // dmlh（OpenDML 扩展头）
  wtr.wBytes(aviIndex.dmlhBuf);

  // LIST strl
  const strlDataSize = 4 + 72 + 48 + aviIndex.superIndxBuf.length;
  wtr.wStr4("LIST");
  wtr.w32(strlDataSize);
  wtr.wStr4("strl");

  // strh
  wtr.wStr4("strh");
  wtr.w32(64);
  wtr.wStr4("vids"); // fccType
  wtr.w32(0); // fccHandler = 0（未压缩，与 BI_RGB 一致，避免 WMP 找解码器）
  wtr.w32(0);
  wtr.w32(0);
  wtr.w32(0); // flags, priority, initialFrames
  wtr.w32(1); // dwScale
  wtr.w32(fps); // dwRate
  wtr.w32(0); // dwStart
  wtr.w32(totalFrames); // dwLength
  wtr.w32(0); // dwSuggestedBufferSize
  wtr.w32(-1); // dwQuality
  wtr.w32(0); // dwSampleSize
  wtr.w32(0);
  wtr.w32(0); // rcFrame left, top (LONG)
  wtr.w32(w);
  wtr.w32(h); // rcFrame right, bottom (LONG)

  // strf (BITMAPINFOHEADER)
  wtr.wStr4("strf");
  wtr.w32(40);
  wtr.w32(40); // biSize
  wtr.w32(w); // biWidth
  wtr.w32(h); // biHeight (top-down)
  wtr.w16(1); // biPlanes
  wtr.w16(32); // biBitCount
  wtr.w32(0); // biCompression = BI_RGB
  wtr.w32(w * h * BPP); // biSizeImage
  wtr.w32(0);
  wtr.w32(0); // biXPelsPerMeter, biYPelsPerMeter
  wtr.w32(0);
  wtr.w32(0); // biClrUsed, biClrImportant

  // Super Index（在 strl 内）
  wtr.wBytes(aviIndex.superIndxBuf);

  // LIST movi
  wtr.wStr4("LIST");
  wtr.w32(moviListSize - 8);
  wtr.wStr4("movi");
}

// ═══════════════════════════════════════════════
// 00db chunk 写入
// ═══════════════════════════════════════════════

export function writeChunkHeader(push, dataSize) {
  const wtr = createWriter(push);
  wtr.wStr4("00db");
  wtr.w32(dataSize);
}

export function writeINDX(push, indxBuf) {
  push(indxBuf);
}

// ═══════════════════════════════════════════════
// 文件条目构建
// ═══════════════════════════════════════════════

export function buildFileEntries(files, nameBufs) {
  const nbArr = nameBufs || files.map((f) => new TextEncoder().encode(f.name));
  const total = nbArr.reduce((s, nb) => s + 2 + 8 + nb.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < files.length; i++) {
    const nb = nbArr[i];
    const nl = nb.length;
    const sz = files[i].size;
    buf[off++] = (nl >>> 8) & 0xff;
    buf[off++] = nl & 0xff;
    for (let j = 7; j >= 0; j--) buf[off++] = (sz >>> (j * 8)) & 0xff;
    buf.set(nb, off);
    off += nl;
  }
  return buf;
}

/**
 * 解析 fileEntries (由解码器调用)
 */
export function parseFileEntries(buf, startOff, fileCount) {
  const entries = [];
  let off = startOff;
  for (let i = 0; i < fileCount; i++) {
    if (off + 10 > buf.length) break;
    const nameLen = (buf[off] << 8) | buf[off + 1];
    if (off + 10 + nameLen > buf.length) break;
    let dataLen = 0;
    for (let j = 0; j < 8; j++) dataLen = (dataLen << 8) | buf[off + 2 + j];
    const name = new TextDecoder().decode(
      buf.subarray(off + 10, off + 10 + nameLen),
    );
    entries.push({ name, size: dataLen });
    off += 10 + nameLen;
  }
  return { entries, entriesEnd: off };
}
