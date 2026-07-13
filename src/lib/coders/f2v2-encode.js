// ═══════════════════════════════════════════════════
// F2V2 编码器 — 文件到 ISOBMFF MP4 流式输出
// CRAFT-2: ftyp + moov + mdat, 单 chunk, stsz 前缀和定位
// 所有 ISOBMFF box 构建逻辑内聚于此
// ═══════════════════════════════════════════════════
"use strict";

import {
  FRAME0_HEADER_SIZE,
  precomputeFramesV2,
} from "../f2v-core.js";
import {
  prepareIndexParams,
  encodeFrame0,
  encodeDataFrame,
} from "./f2v1-encode.js";

// ═══════════════════════════════════════════════
// ISOBMFF 工具函数
// ═══════════════════════════════════════════════

/** 分配 box buffer: [size:4 BE][type:4 ASCII]，返回 { buf, v:DataView, off:8 } */
function allocBox(size, fourCC) {
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setUint32(0, size, false);
  buf[4] = fourCC.charCodeAt(0);
  buf[5] = fourCC.charCodeAt(1);
  buf[6] = fourCC.charCodeAt(2);
  buf[7] = fourCC.charCodeAt(3);
  return { buf, v, off: 8 };
}

function w16BE(v, off, val) { v.setUint8(off, (val >>> 8) & 0xff); v.setUint8(off + 1, val & 0xff); }
function w32BE(v, off, val) { v.setUint32(off, val, false); }
function w64BE(v, off, val) {
  const hi = Math.floor(val / 0x100000000) >>> 0;
  const lo = val >>> 0;
  v.setUint32(off, hi, false);
  v.setUint32(off + 4, lo, false);
}
function writeIdentityMatrix(v, off) {
  w32BE(v, off,      0x00010000); w32BE(v, off + 4,  0x00000000); w32BE(v, off + 8,  0x00000000);
  w32BE(v, off + 12, 0x00000000); w32BE(v, off + 16, 0x00010000); w32BE(v, off + 20, 0x00000000);
  w32BE(v, off + 24, 0x00000000); w32BE(v, off + 28, 0x00000000); w32BE(v, off + 32, 0x40000000);
}
function boxHeaderBuf(size, fourCC) {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint32(0, size, false);
  buf[4] = fourCC.charCodeAt(0); buf[5] = fourCC.charCodeAt(1);
  buf[6] = fourCC.charCodeAt(2); buf[7] = fourCC.charCodeAt(3);
  return buf;
}

// ═══════════════════════════════════════════════
// ISOBMFF Box Builders
// ═══════════════════════════════════════════════

function buildFTYP() {
  const { buf, v } = allocBox(20, "ftyp");
  w32BE(v, 8, 0x736f6d69); w32BE(v, 12, 0x00000200); w32BE(v, 16, 0x736f6d69);
  return buf;
}
function buildMVHD(timescale, duration) {
  const { buf, v } = allocBox(108, "mvhd");
  v.setUint8(8, 0);
  w32BE(v, 12, 0); w32BE(v, 16, 0); w32BE(v, 20, timescale); w32BE(v, 24, duration);
  w32BE(v, 28, 0x00010000); w16BE(v, 32, 0x0100);
  writeIdentityMatrix(v, 44);
  w32BE(v, 104, 2);
  return buf;
}
function buildTKHD(duration, w, h) {
  const { buf, v } = allocBox(92, "tkhd");
  v.setUint8(8, 0); v.setUint8(11, 3);
  w32BE(v, 12, 0); w32BE(v, 16, 0); w32BE(v, 20, 1); w32BE(v, 24, 0); w32BE(v, 28, duration);
  w16BE(v, 40, 0); w16BE(v, 42, 0); w16BE(v, 44, 0);
  writeIdentityMatrix(v, 48);
  w32BE(v, 84, w << 16); w32BE(v, 88, h << 16);
  return buf;
}
function buildMDHD(timescale, duration) {
  const { buf, v } = allocBox(32, "mdhd");
  v.setUint8(8, 0);
  w32BE(v, 12, 0); w32BE(v, 16, 0); w32BE(v, 20, timescale); w32BE(v, 24, duration);
  w16BE(v, 28, 0x55C4);
  return buf;
}
function buildHDLR() {
  const { buf, v } = allocBox(33, "hdlr");
  v.setUint8(8, 0);
  w32BE(v, 12, 0); w32BE(v, 16, 0x76696465);
  w32BE(v, 20, 0); w32BE(v, 24, 0); w32BE(v, 28, 0);
  v.setUint8(32, 0);
  return buf;
}
function buildVMHD() {
  const { buf, v } = allocBox(20, "vmhd");
  v.setUint8(8, 0); v.setUint8(11, 1);
  w16BE(v, 12, 0); w16BE(v, 14, 0); w16BE(v, 16, 0); w16BE(v, 18, 0);
  return buf;
}
function buildDREF() {
  const { buf, v } = allocBox(28, "dref");
  v.setUint8(8, 0);
  w32BE(v, 12, 1);
  // url box (12B)
  w32BE(v, 16, 12);
  v.setUint8(20, 0x75); v.setUint8(21, 0x72); v.setUint8(22, 0x6c); v.setUint8(23, 0x20);
  v.setUint8(24, 0); v.setUint8(27, 1);
  return buf;
}
function buildSTSD(w, h) {
  const { buf, v } = allocBox(102, "stsd");
  v.setUint8(8, 0);
  w32BE(v, 12, 1);
  // VisualSampleEntry (86B)
  w32BE(v, 16, 86);
  v.setUint8(20, 0x72); v.setUint8(21, 0x61); v.setUint8(22, 0x77); v.setUint8(23, 0x20);
  w16BE(v, 30, 1);
  w16BE(v, 32, 0);
  w16BE(v, 48, w); w16BE(v, 50, h);
  w32BE(v, 52, 0x00480000); w32BE(v, 56, 0x00480000);
  w32BE(v, 60, 0);
  w16BE(v, 64, 1);
  v.setUint8(66, 0);
  w16BE(v, 98, 0x0020); w16BE(v, 100, 0xFFFF);
  return buf;
}
function buildSTTS(totalFrames) {
  const { buf, v } = allocBox(24, "stts");
  v.setUint8(8, 0);
  w32BE(v, 12, 1); w32BE(v, 16, totalFrames); w32BE(v, 20, 1000);
  return buf;
}
function buildSTSC(totalFrames) {
  const { buf, v } = allocBox(28, "stsc");
  v.setUint8(8, 0);
  w32BE(v, 12, 1); w32BE(v, 16, 1); w32BE(v, 20, totalFrames); w32BE(v, 24, 1);
  return buf;
}
function buildSTSZ(frameInfo) {
  const N = frameInfo.totalFrames;
  const size = 20 + 4 * N;
  const { buf, v } = allocBox(size, "stsz");
  v.setUint8(8, 0);
  w32BE(v, 12, 0); w32BE(v, 16, N);
  const s0 = FRAME0_HEADER_SIZE + (8 + frameInfo.fileListSize);
  let off = 20;
  w32BE(v, off, s0);
  for (let i = 1; i < N; i++) { off += 4; w32BE(v, off, frameInfo.frames[i].dataSize); }
  return buf;
}
function buildCO64(mdatDataStart) {
  const { buf, v } = allocBox(24, "co64");
  v.setUint8(8, 0);
  w32BE(v, 12, 1); w64BE(v, 16, mdatDataStart);
  return buf;
}
function buildMDATHeader(mdatDataTotal, headerSize) {
  if (headerSize === 8) {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, 8 + mdatDataTotal, false);
    buf[4] = 0x6d; buf[5] = 0x64; buf[6] = 0x61; buf[7] = 0x74;
    return buf;
  }
  const buf = new Uint8Array(16);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 1, false);
  buf[4] = 0x6d; buf[5] = 0x64; buf[6] = 0x61; buf[7] = 0x74;
  const total = 16 + mdatDataTotal;
  const hi = Math.floor(total / 0x100000000) >>> 0;
  const lo = total >>> 0;
  v.setUint32(8, hi, false); v.setUint32(12, lo, false);
  return buf;
}

// ═══════════════════════════════════════════════
// MP4 Box 编排器
// ═══════════════════════════════════════════════

export function buildMP4Boxes(frameInfo, w, h, fps) {
  const N = frameInfo.totalFrames;
  const timescale = fps * 1000;
  const duration = N * 1000;

  const ftyp = buildFTYP();
  const mvhd = buildMVHD(timescale, duration);
  const tkhd = buildTKHD(duration, w, h);
  const mdhd = buildMDHD(timescale, duration);
  const hdlr = buildHDLR();
  const vmhd = buildVMHD();
  const dref = buildDREF();
  const stsd = buildSTSD(w, h);
  const stts = buildSTTS(N);
  const stsc = buildSTSC(N);
  const stsz = buildSTSZ(frameInfo);

  const s0 = FRAME0_HEADER_SIZE + (8 + frameInfo.fileListSize);
  let mdatDataTotal = s0;
  for (let i = 1; i < N; i++) mdatDataTotal += frameInfo.frames[i].dataSize;

  const moovConstSize = 559;
  const moovSize = moovConstSize + 4 * N;
  const mdatNeedsLargesize = (mdatDataTotal + 8) > 0xFFFFFFFF;
  const mdatHeaderSize = mdatNeedsLargesize ? 16 : 8;
  const mdatDataStart = 20 + moovSize + mdatHeaderSize;
  const mdatSize = mdatHeaderSize + mdatDataTotal;
  const totalFileSize = 20 + moovSize + mdatSize;

  const co64 = buildCO64(mdatDataStart);
  const mdatHdr = buildMDATHeader(mdatDataTotal, mdatHeaderSize);

  const dinfSize = 8 + dref.length;
  const stblSize = 8 + stsd.length + stts.length + stsc.length + stsz.length + co64.length;
  const minfSize = 8 + vmhd.length + dinfSize + stblSize;
  const mdiaSize = 8 + mdhd.length + hdlr.length + minfSize;
  const trakSize = 8 + tkhd.length + mdiaSize;
  const moovActual = 8 + mvhd.length + trakSize;

  if (moovActual !== moovSize) {
    throw new Error(
      `moov size mismatch: expected ${moovSize}, got ${moovActual} (diff ${moovActual - moovSize})`,
    );
  }

  return {
    ftyp, moovHdr: boxHeaderBuf(moovActual, "moov"), mvhd,
    trakHdr: boxHeaderBuf(trakSize, "trak"), tkhd,
    mdiaHdr: boxHeaderBuf(mdiaSize, "mdia"), mdhd, hdlr,
    minfHdr: boxHeaderBuf(minfSize, "minf"), vmhd,
    dinfHdr: boxHeaderBuf(dinfSize, "dinf"), dref,
    stblHdr: boxHeaderBuf(stblSize, "stbl"), stsd, stts, stsc, stsz, co64,
    mdatHdr, mdatDataStart, mdatDataTotal, totalFileSize, moovSize,
  };
}

// ═══════════════════════════════════════════════════
// MP4 ReadableStream
// ═══════════════════════════════════════════════════

export function buildF2V2Stream(frameInfo, files, password, w, h, fps, opts) {
  const { frames, totalFrames, fileTotalData } = frameInfo;
  const boxes = buildMP4Boxes(frameInfo, w, h, fps);
  const totalData = fileTotalData || 1;

  const prefixSum = [0];
  for (let i = 1; i < frames.length; i++)
    prefixSum[i] = prefixSum[i - 1] + (frames[i - 1]?.dataSize || 0);

  return new ReadableStream({
    async start(controller) {
      const push = (d) => controller.enqueue(d);
      const closeStream = () => { try { controller.close(); } catch {} };
      const isCancelled = () => opts?.isCancelled?.() || false;

      const reportProgress = (fraction, idx) => {
        const cb = prefixSum[idx] || 0;
        const ds = frames[idx]?.dataSize || 0;
        opts?.onProgress?.(Math.min(1, (cb + fraction * ds) / totalData));
      };

      try {
        push(boxes.ftyp);
        push(boxes.moovHdr); push(boxes.mvhd);
        push(boxes.trakHdr); push(boxes.tkhd);
        push(boxes.mdiaHdr); push(boxes.mdhd); push(boxes.hdlr);
        push(boxes.minfHdr); push(boxes.vmhd);
        push(boxes.dinfHdr); push(boxes.dref);
        push(boxes.stblHdr); push(boxes.stsd); push(boxes.stts);
        push(boxes.stsc); push(boxes.stsz); push(boxes.co64);
        push(boxes.mdatHdr);

        if (isCancelled()) return;

        const params = await prepareIndexParams(files, password, frameInfo.nameBufs);
        if (isCancelled()) return;

        let cum = await encodeFrame0(push, params, frameInfo, {
          onProgress: (f) => reportProgress(f, 0),
        });
        if (isCancelled()) return;

        for (let i = 1; i < frames.length; i++) {
          if (isCancelled()) return;
          cum += await encodeDataFrame(
            push, frames[i], files, params.encKey, params.frameSalt, cum,
            { chunkSize: opts?.chunkSize, isCancelled, onProgress: (f) => reportProgress(f, i) },
          );
        }

        closeStream();
        opts?.onProgress?.(1);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() { if (opts?.isCancelled) opts.isCancelled = true; },
  });
}

export async function encodeToMP4(files, password, w, h, fps, opts) {
  return buildF2V2Stream(precomputeFramesV2(files, w, h), files, password, w, h, fps, opts);
}
