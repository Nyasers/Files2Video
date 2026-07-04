# F2V1 · 帧编码设计

## 核心约束

- 全局数据级加密：单根 AES-CTR 流贯穿所有帧
- 帧 0 只承载加密上下文 + 元数据（fileCount + fileEntries），不装文件数据
- 帧 1..N 纯加密文件数据，无帧头
- 所有帧通过 AVI 容器提供的物理边界（00db chunk header + indx）定位
- 没有帧内标识符、分隔符、校验码
- 一次身份验证覆盖全局（帧 0 的 encMagic）
- 容器格式：AVI 2.0（OpenDML），帧为未压缩 32-bit BGRA 00db chunk
- 纯视频流，无音频轨道，dwStreams = 1

---

## 与 F2P6 的核心设计差异

| 维度 | F2P6 | F2V1 | 原因 |
| ---- | ---- | ---- | ---- |
| 容器 | 多个 BMP 文件 | 单个 AVI 文件 | BMP 4GB 硬上限、无帧序 |
| 加密 | 每分卷独立 segSalt + indexSalt 耦合 | 单 frameSalt，连续 AES-CTR 流 | AVI 单体容器提供帧序保证 |
| 元数据 | 索引分卷明文头 + 加密区，混装数据 | 帧 0 明文头 + 加密区，纯元数据 | AVI 不等长帧，帧 0 独立于数据 |
| 身份验证 | 每分卷 encMagic | 仅帧 0 一次 encMagic | 文件级容器，无需逐段验证 |
| 帧头开销 | 36B / 32B | 28B / 0B | 数据帧无头 |
| 数据定位 | 像素区 + tail 推导 | indx 精确偏移 | AVI 索引表原生提供 |

---

## 加密模型

```
key = PBKDF2(password, frameSalt, iter)
encMagic: AES-CTR("F2V1", key, frameSalt, 0, 128)   blockOff=0, 取前 4B
数据流:   AES-CTR(明文,  key, frameSalt, 1, 128)    blockOff=1 起, 贯穿所有帧
          帧 0 加密区: fileCount + fileEntries
          帧 1..N 加密区: 全部文件数据
```

---

## 帧结构

### 帧 0（元数据帧）

```
offset  size  field              note
  0      4    magic=0x46325631   明文 "F2V1"
  4      4    encMagic           4B, AES-CTR(key, frameSalt, 0, 128) 前 4B
  8     16    frameSalt          16B 随机, PBKDF2 salt + AES-CTR counter base
 24      4    iter               PBKDF2 迭代次数 (默认 10000)
                                 -- AES-CTR(key, frameSalt, 1, 128) 从此开始 --
 28      8    fileCount          文件总数 (大端 8B)
 36      ?    fileEntries        文件条目列表
```

帧 0 为纯元数据帧，不包含文件数据。AVI 00db chunk 的实际大小 = 8 + 28 + 加密区长度，可能远小于 w×h×4。

fileEntries 格式（与帧 1..N 的数据共享同一 AES-CTR 流）：

```
[2B nameLen][8B dataLen][nB name(UTF-8)]
```

重复 fileCount 次。nameLen + dataLen + name 在加密区原文中连续拼接。

### 帧 1..N（数据帧）

```
offset  size  field              note
  0      ?    data               AES-CTR(原文, key, frameSalt, blockOff, 128)
                                   接续帧 0 的加密流, 无帧头
```

帧头 0B。不包含 magic、encMagic、frameID、checksum 或任何字段。
容器层使用 AVI 00db chunk header + indx 索引确定位。

---

## 帧容量

| 帧 | 数据容量 | 说明 |
| -- | -------- | ---- |
| 帧 0 | w×h×4 - 28 | 实际只装 fileCount + fileEntries，剩余空间未使用 |
| 帧 1..N | w×h×4 | 纯文件数据，无帧头 |

帧 0 的 00db chunk size 实际远小于 w×h×4（因为只装少量元数据），AVI 不等长帧原生支持。

---

## AES-CTR 流连续性

帧之间不重置 counter。帧 0 加密区结束后，帧 1 直接在下一 blockOff 接续：

```
帧 0 加密区:  blockOff=1,  累计字节 S0 = 8 + fileListSize
帧 1 数据区:  blockOff=1+floor(S0/16),  prePad = S0%16
帧 2 数据区:  blockOff=1+floor((S0+S1)/16), prePad = (S0+S1)%16
```

编码器在处理跨帧边界时，对第一块数据做 prePad 零填充以对齐 AES-CTR block 边界，写文件时只写入实际加密字节（不含填充）。解码器读取后先补零、再解密、再切片。

---

## AVI 容器布局

```
RIFF('AVI ')
  LIST('hdrl')
    avih          dwStreams=1, dwFlags=AVIF_MUSTUSEINDEX
    LIST('strl')
      strh        fccType='vids', fccHandler='F2V1'
      strf        BITMAPINFOHEADER, w/h, BPP=32, BI_RGB
  LIST('movi')
    00db(帧 0)    28B 明文上下文 + 加密元数据（不等长，通常很小）
    00db(帧 1)    纯加密文件数据（不等长）
    ...
    00db(帧 N)    纯加密文件数据（不等长）
  indx            OpenDML super index, 64-bit 偏移量
```

所有尺寸在预计算阶段已知，RIFF size 和 LIST size 均可一次性填正。

---

## 预计算

```
输入: files[], w, h
BPP = 4

fileListSize = sum (2 + 8 + nameLen)
fileTotalData = sum file.size

// 帧 0 纯元数据
frame0EncData = 8 + fileListSize             // fileCount + fileEntries
frame0Total = 28 + frame0EncData             // 00db chunk 实际大小 = 8 + 28 + frame0EncData

// 数据帧 1..N
dataPerFrame = w * h * BPP                    // 无帧头
dataFrameCount = fileTotalData > 0 ? ceil(fileTotalData / dataPerFrame) : 0
frameCount = 1 + dataFrameCount

// 帧数据分配
frames[0] = { isMeta: true, encStart: 28, dataSize: frame0EncData }

for i = 1 .. frameCount-1:
  rem = fileTotalData - (i-1) * dataPerFrame
  frames[i] = { isMeta: false, encStart: 0, dataSize: min(rem, dataPerFrame) }
```

### 边界情况

- 单帧文件: fileTotalData = 0 时 frameCount = 1（仅元数据帧，空文件列表）。实际场景不会出现。
- 元数据超限: 8 + fileListSize > w x h x 4 - 28 时抛错，提示提高分辨率。
- 空数据文件: file.size = 0 的文件占一个 fileEntry，不产生数据帧。

---

## AVI 头部大小预计算

```
moviDataSize = 8 + 28 + frame0EncData + sum (8 + frames[i].dataSize for i>=1)

hdrlSize = 4 + 64 + 8 + 4 + 64 + 48
moviListSize = 4 + moviDataSize
indxSize = 8 + frameCount * 16
totalFileSize = 12 + 8 + hdrlSize + 8 + moviListSize + indxSize

moviStartOffset = 12 + 8 + hdrlSize
```

---

## AVI 索引表预建

```
currMoviOffset = 0
for i, frame in frames:
  frameSize = 8 + (i === 0 ? 28 : 0) + frame.dataSize
  indx.push({ offset: currMoviOffset, size: frameSize, duration: 1 })
  currMoviOffset += frameSize
```

解码器将 indx 条目的 offset 加上 (moviStartOffset + 8) 得到绝对文件偏移。

---

## 编码流程

### 帧 0

```
frameSalt = random(16)
key = PBKDF2(password, frameSalt, iter)
encMagic = AES-CTR("F2V1", key, frameSalt, 0, 128)[0..3]

// 明文头 28B: magic + encMagic + frameSalt + iter
// 加密区: fileCount_BE(8) + fileEntries
metaPlain = fileCount_BE(8) + fileEntries
encrypted = AES-CTR(metaPlain, key, frameSalt, 1, 128)

// 写入 AVI
push(00db header, 8 + 28 + encrypted.length)
push(28B 明文头)
push(encrypted)

cumulative = metaPlain.length
```

### 帧 1..N

```
blockOff = 1 + floor(cumulative / 16)
prePad = cumulative % 16

while data remaining:
  chunk = readFileDataRange(files, frameDataOff + offset, CHUNK)
  aligned = ((prePad + chunk.length + 15) / 16) * 16
  padded = new Uint8Array(aligned)
  padded.set(chunk, prePad)
  encrypted = AES-CTR(padded, key, frameSalt, blockOff, 128)
  push(encrypted.subarray(prePad, prePad + chunk.length))
  cumulative += chunk.length
  blockOff = 1 + floor(cumulative / 16)
  prePad = cumulative % 16
```

### 写入 AVI 文件 (ReadableStream 串行)

```
push(RIFF header + hdrl + movi header)
00db(帧 0):  push(00db header + 明文头 + 加密元数据)
00db(帧 1..N): push(00db header + chunked 加密数据)
push(indx buffer)
closeStream()
```

---

## 解码流程

### 1. 解析 AVI

```
parseAVI(blob):
  RIFF 头: 验证 "RIFF" + "AVI "
  hdrl 遍历:
    avih: fps = 1000000 / dwMicroSecPerFrame
    strf: w = biWidth, h = biHeight
  indx: 条目表, 每个 { moviRelativeOffset, size }
  moviStart = 12 + 8 + hdrlSize + 8
  frames: { absOffset: moviStart + entry.offset, size: entry.size }
```

### 2. 读帧 0

```
f0 = frames[0]
buf = read(blob, f0.absOffset + 8, f0.size - 8)   // 跳过 00db

magic = BE32(buf, 0)          // 验证 0x46325631
encMagic = buf.subarray(4, 8)
frameSalt = buf.subarray(8, 24)
iter = BE32(buf, 24)

key = PBKDF2(password, frameSalt, iter)
verify: AES-CTR(encMagic, key, frameSalt, 0, 128) == "F2V1"

encArea = buf.subarray(28)
decrypted = AES-CTR(encArea, key, frameSalt, 1, 128)

fileCount = BE64(decrypted, 0)
entries = parseFileEntries(decrypted, 8, fileCount)
fileEntriesEnd = 8 + sum(2+8+nameLen for each entry)

// 文件全局偏移表
cumulative = 0
for entry in entries:
  entry.globalOffset = cumulative
  cumulative += entry.size

cumulativeEncrypted = fileEntriesEnd   // 帧 0 加密区总长度
```

### 3. 读帧 1..N

```
for each data frame:
  raw = read(blob, frame.absOffset + 8, frame.size - 8)

  blockOff = 1 + floor(cumulativeEncrypted / 16)
  prePad = cumulativeEncrypted % 16
  alignedLen = ((prePad + raw.length + 15) / 16) * 16

  padded = new Uint8Array(alignedLen)
  padded.set(raw, prePad)
  decrypted = AES-CTR(padded, key, frameSalt, blockOff, 128)

  plainChunk = decrypted.subarray(prePad, prePad + raw.length)
  // 推入输出流或写入文件缓冲区

  cumulativeEncrypted += raw.length
```

### 4. 文件数据提取

与 F2P6 相同的线性偏移模型。建立全局文件偏移表后，对每个文件的字节区间映射到覆盖它的帧区间，逐帧 AES-CTR 对齐解密后拼接。

---

## 元数据分布

| 信息 | 存放位置 |
| ---- | -------- |
| 魔数 F2V1 | 帧 0 明文 0..3 |
| encMagic | 帧 0 明文 4..7 |
| frameSalt | 帧 0 明文 8..23 |
| PBKDF2 迭代数 | 帧 0 明文 24..27 |
| 分辨率 w/h | AVI strf |
| 帧率 fps | AVI avih |
| 帧偏移 / 大小 | AVI indx |
| 帧总数 | indx 条目数 |
| 文件总数 | 帧 0 加密区 0..7 |
| 文件条目 | 帧 0 加密区 8.. |
| 文件数据 | 帧 1..N 加密区，连续贯穿 |

无重复，无冗余，每件事只在一个地方出现一次。