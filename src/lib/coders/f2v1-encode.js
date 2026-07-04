// ═══════════════════════════════════════════════════
// F2V 编码器 — 文件到 AVI 流式输出
// ═══════════════════════════════════════════════════
//
// 编码流程 (CRAFT-1):
//   1. precomputeFrames → frameInfo
//   2. buildAVIIndex    → aviIndex
//   3. prepareIndexParams → { encKey, frameSalt, iter, encMagic, fileEntries }
//   4. ReadableStream:
//      a. writeAVIHeader
//      b. encodeFrame0  (00db + 28B 明文 + 加密元数据)
//      c. encodeDataFrame (00db + 加密数据, × N)
//      d. writeINDX
//
// ═══════════════════════════════════════════════════
"use strict";

import {
  deriveEncKey,
  aesEncrypt,
  readFileDataRange,
  precomputeFrames,
  buildAVIIndex,
  writeAVIHeader,
  writeChunkHeader,
  writeINDX,
  writeIDX1,
  buildFileEntries,
  FRAME0_HEADER_SIZE,
  F2V1,
  createWriter,
} from "../f2v-core.js";

// ═══════════════════════════════════════════════════
// 加密参数准备
// ═══════════════════════════════════════════════════

export async function prepareIndexParams(files, password, nameBufs) {
  const frameSalt = crypto.getRandomValues(new Uint8Array(16));
  const iter = 10000;
  const encKey = await deriveEncKey(password, frameSalt, iter);

  // encMagic: AES-CTR("F2V1", key, frameSalt, 0, 128)
  const emFull = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x56, 0x31]),
    encKey,
    frameSalt,
    0,
    128,
  );
  const encMagic = emFull.subarray(0, 4);
  const fileEntries = buildFileEntries(files, nameBufs);

  return {
    encKey,
    frameSalt,
    iter,
    encMagic,
    fileEntries,
    fileCount: files.length,
  };
}

// ═══════════════════════════════════════════════════
// 帧 0 编码（纯元数据帧）
// ═══════════════════════════════════════════════════

/**
 * 编码帧 0：28B 明文头 + 加密元数据
 * 通过 push 回调推入流
 */
export async function encodeFrame0(push, params, frameInfo, opts) {
  const { encKey, frameSalt, iter, encMagic, fileEntries, fileCount } = params;
  const wtr = createWriter(push);

  opts?.onProgress?.(0);

  // ── 明文头 28B ──
  wtr.w32BE(F2V1); // magic
  wtr.wBytes(encMagic); // 4B
  wtr.wBytes(frameSalt); // 16B
  wtr.w32BE(iter); // 4B

  // ── 加密区: fileCount(8B BE) + fileEntries ──
  const metaPlain = new Uint8Array(8 + fileEntries.length);
  // fileCount (大端 8B)
  let off = 0;
  for (let i = 7; i >= 0; i--)
    metaPlain[off++] = (fileCount >>> (i * 8)) & 0xff;
  metaPlain.set(fileEntries, 8);

  const encrypted = await aesEncrypt(metaPlain, encKey, frameSalt, 1, 128);
  wtr.wBytes(encrypted);

  opts?.onProgress?.(1);

  return metaPlain.length; // 返回元数据字节数，供帧 1 blockOff 计算
}

// ═══════════════════════════════════════════════════
// 数据帧编码 (帧 1..N)
// ═══════════════════════════════════════════════════

/**
 * 编码一个数据帧: chunked 加密写入，无帧头
 *
 * @param {function}   push
 * @param {object}     frame     - frameInfo.frames[i]
 * @param {File[]}     files
 * @param {CryptoKey}  encKey
 * @param {Uint8Array} frameSalt
 * @param {number}     cumulativeBefore - 此帧前累计加密字节数
 * @param {object}     [opts]
 * @param {number}     [opts.chunkSize] - 默认 64KB
 * @param {function}   [opts.isCancelled]
 * @param {function}   [opts.onProgress]
 * @returns {number} 此帧数据长度 (用于更新 cumulative)
 */
export async function encodeDataFrame(
  push,
  frame,
  files,
  encKey,
  frameSalt,
  cumulativeBefore,
  opts,
) {
  const CHUNK = (opts?.chunkSize || 64) * 1024;

  opts?.onProgress?.(0);

  let blockOff = 1 + Math.floor(cumulativeBefore / 16);
  let prePad = cumulativeBefore % 16;
  let remaining = frame.dataSize;
  let offset = 0;
  let totalWritten = 0;

  while (remaining > 0) {
    if (opts?.isCancelled?.()) return totalWritten;

    const take = Math.min(remaining, CHUNK);
    const data = await readFileDataRange(
      files,
      frame.dataOffset + offset,
      take,
    );

    // prePad 对齐: 插入前导零，加密后去掉
    const aligned = Math.ceil((prePad + data.length) / 16) * 16;
    const padded = new Uint8Array(aligned);
    padded.set(data, prePad);
    const encrypted = await aesEncrypt(
      padded,
      encKey,
      frameSalt,
      blockOff,
      128,
    );

    // 推入: 去掉 prePad 对齐零
    push(encrypted.subarray(prePad, prePad + data.length));

    totalWritten += data.length;
    offset += data.length;
    remaining -= data.length;

    // 更新 blockOff / prePad
    const totalBytes = cumulativeBefore + totalWritten;
    blockOff = 1 + Math.floor(totalBytes / 16);
    prePad = totalBytes % 16;

    opts?.onProgress?.(totalWritten / frame.dataSize);
  }

  try {
    opts?.onProgress?.(1);
  } catch (e) {
    console.error("encodeDataFrame onProgress threw:", e);
  }
  return totalWritten;
}

// ═══════════════════════════════════════════════════
// 完整 AVI 流构建
// ═══════════════════════════════════════════════════

/**
 * 构建完整的 AVI ReadableStream
 *
 * @param {object}   frameInfo - precomputeFrames 返回值
 * @param {File[]}   files
 * @param {string}   password
 * @param {number}   w
 * @param {number}   h
 * @param {number}   fps
 * @param {object}   [opts]
 * @param {number}   [opts.chunkSize]
 * @param {function} [opts.isCancelled]
 * @param {function} [opts.onProgress] - (fraction: 0..1) => void
 * @returns {ReadableStream}
 */
export function buildF2VStream(frameInfo, files, password, w, h, fps, opts) {
  const { frames, totalFrames, fileTotalData } = frameInfo;
  const aviIndex = buildAVIIndex(frameInfo, fps);
  const totalData = fileTotalData || 1;

  // 前缀和: 每帧之前已完成的数据字节
  const prefixSum = [0];
  for (let i = 1; i < frames.length; i++)
    prefixSum[i] = prefixSum[i - 1] + (frames[i - 1]?.dataSize || 0);

  return new ReadableStream({
    async start(controller) {
      const push = (d) => controller.enqueue(d);
      const closeStream = () => {
        try {
          controller.close();
        } catch {}
      };
      const isCancelled = () => opts?.isCancelled?.() || false;

      const reportProgress = (fraction, idx) => {
        const completedBefore = prefixSum[idx] || 0;
        const ds = frames[idx]?.dataSize || 0;
        const overall = (completedBefore + fraction * ds) / totalData;
        opts?.onProgress?.(Math.min(1, overall));
      };

      try {
        // ── AVI 头 ──
        writeAVIHeader(push, aviIndex, w, h, fps, totalFrames);
        if (isCancelled()) return;

        // ── 加密参数 ──
        const params = await prepareIndexParams(
          files,
          password,
          frameInfo.nameBufs,
        );
        if (isCancelled()) return;

        let cumulative = 0; // 累计加密字节数

        // ── 帧 0 (元数据) ──
        {
          const fi = frames[0];
          writeChunkHeader(push, FRAME0_HEADER_SIZE + fi.dataSize);
          cumulative = await encodeFrame0(push, params, fi, {
            onProgress: (f) => reportProgress(f, 0),
          });
          if (fi.chunkSize % 2 !== 0) push(new Uint8Array([0])); // WORD 对齐
          if (isCancelled()) return;
        }

        // ── 帧 1..N (数据) ──
        for (let i = 1; i < frames.length; i++) {
          if (isCancelled()) return;
          const fi = frames[i];
          writeChunkHeader(push, fi.dataSize);
          const written = await encodeDataFrame(
            push,
            fi,
            files,
            params.encKey,
            params.frameSalt,
            cumulative,
            {
              chunkSize: opts?.chunkSize,
              isCancelled,
              onProgress: (f) => reportProgress(f, i),
            },
          );
          cumulative += written;
          if (fi.chunkSize % 2 !== 0) push(new Uint8Array([0])); // WORD 对齐
          if (isCancelled()) return;
        }

        // ── RIFF WORD 对齐填充 ──
        if (aviIndex.moviPad) push(new Uint8Array([0]));

        // ── idx1 + indx ──
        writeIDX1(push, aviIndex.idx1Buf);
        writeINDX(push, aviIndex.indxBuf);

        closeStream();
        opts?.onProgress?.(1);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      if (opts?.isCancelled) opts.isCancelled = true;
    },
  });
}

/**
 * 便捷入口: 文件列表 → AVI ReadableStream
 */
export async function encodeToAVI(files, password, w, h, fps, opts) {
  const frameInfo = precomputeFrames(files, w, h);
  return buildF2VStream(frameInfo, files, password, w, h, fps, opts);
}
