# F2V2 · ISOBMFF 容器设计

## 核心约束

- 全局数据级加密：单根 AES-CTR 流贯穿所有帧（与 CRAFT-1 相同，不碰加密层）
- 帧 0 只承载加密上下文 + 元数据（fileCount + fileEntries），不装文件数据
- 帧 1..N 纯加密文件数据，无帧头、无分隔符
- 所有帧通过 ISOBMFF sample table（stsz 精确大小 + 前缀和定位），替代 AVI 的 00db chunk header + indx
- 一次身份验证覆盖全局（帧 0 的 encMagic）
- 容器格式：ISOBMFF MP4，单轨 raw video（FourCC = `raw `），无音频
  > 此 MP4 使用无压缩 `raw ` 像素，浏览器 `<video>` 无法直接回放。容器仅用于文件封装，解码需自定义 FileReader + 解密路径（与 CRAFT-1 `video/avi` 同理）。
- 像素格式 32-bit BGRA，完全不变
- **所有 N 个 sample 归入单个 chunk**，co64 仅一条记录；帧不填充，帧 0 和末帧保留实际大小

---

## 与 CRAFT-1 的核心设计差异

| 维度         | CRAFT-1 (AVI 2.0)                | CRAFT-2 (ISOBMFF)                         | 原因                                                                      |
| ------------ | -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| 容器         | RIFF/AVI + OpenDML 扩展          | ISOBMFF (MP4)                             | AVI 是 1992 年的格式，OpenDML 是补丁；ISOBMFF 是 ISO 标准的现代容器       |
| 帧定位       | 00db chunk (8B 头) + indx 索引   | stsz 前缀和 + co64 单条目                 | stsz 存精确字节数，co64 只存 mdat 起始偏移，sample 间边界由 stsz 累加得出 |
| 对齐填充     | WORD 对齐 (每 chunk 可能补 1B)   | ISOBMFF 无对齐要求                        | 减少填充字节，简化编解码逻辑                                              |
| 索引结构     | Super Index → ix00 二级索引      | stsz 一级平铺                             | 无需二级索引；co64 退化为单条常量                                         |
| 文件大小     | RIFF size (4B) + OpenDML 扩展    | Box size + co64 (64-bit) + mdat largesize | 全链路 64-bit 寻址，彻底消除 4GB 上限                                     |
| Codec 声明   | BITMAPINFOHEADER.biCompression=0 | VisualSampleEntry format=`raw `           | 语义等价：无压缩原始像素                                                  |
| MIME         | `video/avi`                      | `video/mp4`                               | MP4 在浏览器生态中更通用                                                  |
| 帧头开销     | 数据帧 8B 00db header            | 数据帧 0B（stsz 表项 4B）                 | 帧数据直接写入 mdat，sample 边界由 stsz 定义                              |
| 每帧容器开销 | 8B header + 16B indx 表项 = 24B  | 4B stsz 表项                              | 单 chunk 使 co64 退化为常量 (24B 全文件)                                  |

---

## 设计决策：为什么不逐帧建 co64

ISOBMFF 允许把 N 个 sample 映射到 1 个 chunk（stsc 声明 `N samples → 1 chunk`），此时 co64 只需要一条记录。sample 间的边界完全由 stsz 的前缀和决定。

| 方案                | co64 条目 | stsz 条目 | 每帧容器开销           | N=10万 时总开销 |
| ------------------- | --------- | --------- | ---------------------- | --------------- |
| 逐帧 chunk          | N         | N         | 12B (8+4)              | 1.2 MB          |
| **单 chunk (采纳)** | **1**     | **N**     | **4B**                 | **400 KB**      |
| 常数填充            | 1         | 0         | 0B (但帧 0/末帧需填充) | ~800 KB 填充    |

单 chunk 方案的总开销比 F2P6 不分卷（36B）多近 600B 的固定容器头加每帧 4B stsz 表项。这个差距是单体容器自带索引的结构性代价，等效于把 F2P6 分卷时文件系统的 inode/MFT 开销显式化了。

交叉点：F2P6 分卷模式每卷容器开销 36B。F2V2 总开销 = 固定部分（ftyp 20 + moov 559 + mdat_hdr 8 = 587B）+ 每帧 4B（stsz 表项）。令 587 + 4N = 36N，解得 N ≈ 18.3。超过 18 帧后 F2V2 更省。对于 640×320×32bpp ≈ 819KB/帧，约 15MB 起 F2V2 占优。

---

## 加密模型

**完全不变。** 从 CRAFT-1 照搬：

```
key = PBKDF2(password, frameSalt, iter)
encMagic: AES-CTR("F2V1", key, frameSalt, 0, 128)   blockOff=0, 取前 4B
数据流:   AES-CTR(明文,  key, frameSalt, 1, 128)    blockOff=1 起, 贯穿所有帧
          帧 0 加密区: fileCount + fileEntries
          帧 1..N 加密区: 全部文件数据
```

帧之间不重置 counter。帧 0 加密区结束后，帧 1 直接在下一 blockOff 接续。

---

## 帧结构

**完全不变。** 帧 0 为 28B 明文头 + 加密元数据，帧 1..N 为纯加密文件数据。
唯一变化：帧数据不再包裹于 AVI `00db` chunk 内，而是直接作为 ISOBMFF sample 写入 mdat。

### 帧 0（元数据帧 / sample 0）

```
offset  size  field              note
  0      4    magic=0x46325631   明文 "F2V1"
  4      4    encMagic           4B, AES-CTR(key, frameSalt, 0, 128) 前 4B
  8     16    frameSalt          16B 随机
 24      4    iter               PBKDF2 迭代次数 (默认 10000)
                                 -- AES-CTR(key, frameSalt, 1, 128) 从此开始 --
 28      8    fileCount          文件总数 (大端 8B)
 36      ?    fileEntries        文件条目列表
```

smpl[0].size = FRAME0_HEADER_SIZE + frame0EncData = 28 + frame0EncData（**精确值，不填充**）

### 帧 1..N-1（满数据帧 / sample 1..N-1）

```
offset  size  field              note
  0      w×h×4 data              AES-CTR(原文, key, frameSalt, blockOff, 128)
                                   接续帧 0 的加密流, 无帧头
```

smpl[i].size = w × h × 4

### 帧 N-1（未满数据帧 / sample N-1，最后一帧）

```
offset  size  field              note
  0      rem   data              AES-CTR(原文, key, frameSalt, blockOff, 128)
                                   rem = fileTotalData - (N-2) × w × h × 4
                                   恰好等于最后一段剩余数据，无零填充
```

smpl[N-1].size = rem（**精确值，不填充**）

---

## 帧容量

| 帧                 | 数据容量 | 说明                                             |
| ------------------ | -------- | ------------------------------------------------ |
| 帧 0               | ≤ w×h×4  | 实际只装 fileCount + fileEntries，不填充剩余空间 |
| 帧 1..N-1          | w×h×4    | 满帧，纯文件数据                                 |
| 帧 N-1（最后一帧） | ≤ w×h×4  | 末尾不满帧，无零填充                             |

---

## AES-CTR 流连续性

**不变。** 帧之间不重置 counter：

```
帧 0 加密区:  blockOff=1,  累计字节 S0 = 8 + fileListSize
帧 1 数据区:  blockOff=1+floor(S0/16),  prePad = S0%16
帧 2 数据区:  blockOff=1+floor((S0+S1)/16), prePad = (S0+S1)%16
```

编码器做 prePad 零填充对齐 block 边界，写文件只写实际加密字节。解码器先补零、再解密、再切片。

---

## ISOBMFF 容器布局

采用 **moov-at-start**（fast-start）布局。所有 box 大小在预计算阶段确定，无需 seek-back：

```
ftyp (20B)
  ├─ major_brand = 'isom'
  ├─ minor_version = 512
  └─ compatible_brand = 'isom'

moov (559 + 4N)
  ├─ mvhd (108B)       — movie header, timescale = fps × 1000
  └─ trak (443 + 4N)
      ├─ tkhd (92B)    — track header
      └─ mdia (343 + 4N)
          ├─ mdhd (32B) — media header
          ├─ hdlr (33B) — handler 'vide'
          └─ minf (270 + 4N)
              ├─ vmhd (20B)  — video media header
              ├─ dinf (36B)  — data information
              │   └─ dref (28B)
              │       └─ url  (12B, flag=1 self-contained)
              └─ stbl (206 + 4N) — sample table
                  ├─ stsd (102B)   — sample description (1 entry: 'raw ')
                  ├─ stts (24B)    — time-to-sample (1 entry, uniform)
                  ├─ stsc (28B)    — sample-to-chunk (1 entry: N samples → 1 chunk)
                  ├─ stsz (20+4N)  — sample sizes (N entries, 每帧精确大小)
                  └─ co64 (24B)    — chunk offset (1 entry: mdat_data_start)

mdat (8~16 + Σ sample sizes)
  ├─ smpl[0] = 28B 明文头 + 加密元数据             (精确, 不填充)
  ├─ smpl[1] = w×h×4 加密文件数据                  (满帧)
  ├─ ...
  ├─ smpl[N-2] = w×h×4 加密文件数据                (满帧，仅当 N>2)
  └─ smpl[N-1] = rem 加密文件数据                   (末帧, 精确, 不填充)
```

`N = totalFrames`。所有 sample 数据在 mdat 中连续排列，sample 间零间隙，无填充。

---

## Box 详细结构

### ftyp

```
offset  size  field              value
  0      4    size               20
  4      4    type               'ftyp'
  8      4    major_brand        'isom' (0x736F6D69)
 12      4    minor_version      512 (0x00000200)
 16      4    compatible_brand   'isom'
```

### mvhd (Movie Header, version 0)

```
offset  size  field              value
  0      4    size               108
  4      4    type               'mvhd'
  8      1    version            0
  9      3    flags              0
 12      4    creation_time      0
 16      4    modification_time  0
 20      4    timescale          fps × 1000
 24      4    duration           totalFrames × 1000
 28      4    rate               0x00010000 (1.0, 16.16 fixed)
 32      2    volume             0x0100 (full)
 34      2    reserved           0
 36      8    reserved           0, 0
 44     36    matrix             identity (0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000)
 80     24    pre_defined[6]     all 0
104      4    next_track_id      2
```

timescale 取 `fps × 1000`，保证对任意整数 fps，sample_delta = 1000 始终是整数。

### tkhd (Track Header, version 0)

```
offset  size  field              value
  0      4    size               92
  4      4    type               'tkhd'
  8      1    version            0
  9      3    flags              3 (track_enabled | track_in_movie)
 12      4    creation_time      0
 16      4    modification_time  0
 20      4    track_id           1
 24      4    reserved           0
 28      4    duration           same as mvhd.duration
 32      8    reserved           0, 0
 40      2    layer              0
 42      2    alternate_group    0
 44      2    volume             0
 46      2    reserved           0
 48     36    matrix             identity
 84      4    width              w << 16  (16.16 fixed-point)
 88      4    height             h << 16  (16.16 fixed-point)
```

### mdhd (Media Header, version 0)

```
offset  size  field              value
  0      4    size               32
  4      4    type               'mdhd'
  8      1    version            0
  9      3    flags              0
 12      4    creation_time      0
 16      4    modification_time  0
 20      4    timescale          fps × 1000
 24      4    duration           totalFrames × 1000
 28      2    language           0x55C4 ('und', packed 5+5+5 bits: 0x15,0x0E,0x04)
 30      2    pre_defined        0
```

### hdlr (Handler Reference)

```
offset  size  field              value
  0      4    size               33 (empty name: 32 + '\0')
  4      4    type               'hdlr'
  8      1    version            0
  9      3    flags              0
 12      4    pre_defined        0
 16      4    handler_type       'vide' (0x76696465)
 20      4    reserved[0]        0
 24      4    reserved[1]        0
 28      4    reserved[2]        0
 32      1    name               '\0' (空字符串，满足 ISOBMFF null-terminated 要求)
```

### vmhd (Video Media Header)

```
offset  size  field              value
  0      4    size               20
  4      4    type               'vmhd'
  8      1    version            0
  9      3    flags              1 (no lean-ahead)
 12      2    graphicsmode       0 (copy)
 14      2    opcolor[0]         0
 16      2    opcolor[1]         0
 18      2    opcolor[2]         0
```

### dref (Data Reference) + url

```
offset  size  field              value
  0      4    size               28
  4      4    type               'dref'
  8      1    version            0
  9      3    flags              0
 12      4    entry_count        1
 16      4    size               12
 20      4    type               'url '
 24      1    version            0
 25      3    flags              1 (self-contained: data in same file)
```

### dinf (Data Information，容器 box)

```
offset  size  field              value
  0      4    size               36 (= 8 + dref.size)
  4      4    type               'dinf'
  8     28    dref box
```

### stsd (Sample Description)

```
offset  size  field              value
  0      4    size               102
  4      4    type               'stsd'
  8      1    version            0
  9      3    flags              0
 12      4    entry_count        1
 16      4    entry_size         86
 20      4    format             'raw ' (0x20776172)
 24      6    reserved           0
 30      2    data_ref_index     1
 32      2    pre_defined        0
 34      2    reserved           0
 36      4    pre_defined        0
 40      4    pre_defined        0
 44      4    pre_defined        0
 48      2    width              w
 50      2    height             h
 52      4    horizresolution    0x00480000 (72 dpi)
 56      4    vertresolution     0x00480000 (72 dpi)
 60      4    reserved           0
 64      2    frame_count        1
 66     32    compressorname     '\0' (1B length=0) + 31B zero-padded
 98      2    depth              0x0020 (32-bit)
100      2    pre_defined        0xFFFF (-1)
```

format = `raw ` 表示无压缩原始像素。ISOBMFF 中 FourCC 按字面字节存储（0x72 0x61 0x77 0x20），不涉及端序。实际像素布局为 32-bit BGRA（由 width / height / depth=32 隐含定义，编解码双方约定）。

### stts (Time-to-Sample)

所有帧统一时长，仅 1 条记录：

```
offset  size  field              value
  0      4    size               24
  4      4    type               'stts'
  8      1    version            0
  9      3    flags              0
 12      4    entry_count        1
 16      4    sample_count       totalFrames
 20      4    sample_delta       1000 (在 timescale=fps×1000 下，每帧时长 = 1000/timescale = 1/fps 秒)
```

### stsc (Sample-to-Chunk)

**核心优化：** 所有 N 个 sample（含元数据帧 0）归入单一 chunk，co64 退化为常量。

```
offset  size  field                     value
  0      4    size                      28
  4      4    type                      'stsc'
  8      1    version                   0
  9      3    flags                     0
 12      4    entry_count               1
 16      4    first_chunk               1
 20      4    samples_per_chunk         totalFrames
 24      4    sample_description_index  1
```

### stsz (Sample Sizes)

**每个 sample 的精确大小，不做任何填充。** 帧 0 只写 28 + frame0EncData 字节，末帧只写最后一段剩余数据字节：

```
offset  size  field              value
  0      4    size               20 + 4 × totalFrames
  4      4    type               'stsz'
  8      1    version            0
  9      3    flags              0
 12      4    sample_size        0 (variable sizes)
 16      4    sample_count       totalFrames
 20      4    entry[0].size      FRAME0_HEADER_SIZE + frame0EncData   ← 帧 0, 不填充
 24      4    entry[1].size      w × h × 4                            ← 满帧
  ...    ...   ...
  ??      4    entry[N-1].size   rem                                   ← 末帧, 不填充
```

### co64 (Chunk Offset, 64-bit)

**单条目。** 因为 stsc 声明所有 sample 在同一个 chunk 中，co64 只需给出 chunk 的起始偏移：

```
offset  size  field              value
  0      4    size               24
  4      4    type               'co64'
  8      1    version            0
  9      3    flags              0
 12      4    entry_count        1
 16      8    entry[0].offset    mdat_data_start (64-bit LE)
```

### mdat (Media Data)

标准 box（mdat 总大小 ≤ 4GB）：

```
offset  size  field              value
  0      4    size               8 + mdat_data_total
  4      4    type               'mdat'
  8      ?    sample data        连续排列，无填充
```

大文件 box（mdat 总大小 > 4GB，ISOBMFF largesize 机制）：

```
offset  size  field              value
  0      4    size               1 (标记启用 largesize)
  4      4    type               'mdat'
  8      8    largesize          16 + mdat_data_total (64-bit LE)
 16      ?    sample data        连续排列，无填充
```

sample data 按序、连续、无间隙写入：

```
[smpl0: 28B 头 + 加密元数据 (精确)] [smpl1: w×h×4 加密数据] ... [smplN-1: rem 加密数据 (精确)]
```

---

## 预计算

```
输入: files[], w, h, fps
BPP = 4

fileListSize = Σ (2 + 8 + nameLen)
fileTotalData = Σ file.size

// 帧 0 精确大小
frame0EncData = 8 + fileListSize
sample0_size = FRAME0_HEADER_SIZE + frame0EncData           // 28 + frame0EncData, 不填充

// 数据帧
dataPerFrame = w × h × BPP                                  // 无帧头
dataFrameCount = fileTotalData > 0 ? ceil(fileTotalData / dataPerFrame) : 0
totalFrames = 1 + dataFrameCount                            // N

// 帧分配 (与 CRAFT-1 相同)
frames[0] = { isMeta: true, encStart: FRAME0_HEADER_SIZE, dataSize: frame0EncData }
for i = 1 .. dataFrameCount:
  rem_bytes = min(fileTotalData - (i-1) × dataPerFrame, dataPerFrame)
  frames[i] = { isMeta: false, encStart: 0, dataSize: rem_bytes }

// ── ISOBMFF box 大小预计算 (单 chunk 方案) ──
// 从底向上推导（全部 version 0，co64 仅 1 条 = 24B，stsz N 条 = 20+4N）:
//   stbl =  8 + stsd(102) + stts(24) + stsc(28) + stsz_base(20) + co64(24) = 206
//   minf =  8 + vmhd(20) + dinf(36) + stbl = 270
//   mdia =  8 + mdhd(32) + hdlr(33) + minf = 343
//   trak =  8 + tkhd(92) + mdia = 443
//   moov =  8 + mvhd(108) + trak = 559

moov_constant_size = 559

moov_size = 559 + 4 × totalFrames                    // stsz 条目 4B × N

ftyp_size = 20

// mdat header：大文件自动启用 largesize (ISOBMFF §4.2)
// 两遍法消除循环依赖：先用 8B header 估算 total_file_size，
// 若超过 4GB 边界则改用 16B header 重算。8B 的差值不会改变 >2^32 的判定。

sample_prefix[0] = 0
for i = 0 .. totalFrames-1:
  sz = (i == 0) ? sample0_size : frames[i].dataSize
  sample_prefix[i+1] = sample_prefix[i] + sz

mdat_data_total = sample_prefix[totalFrames]

// 第一遍：假设 8B mdat header
est_file_size = ftyp_size + moov_size + 8 + mdat_data_total
mdat_header_size = (est_file_size > 0xFFFFFFFF) ? 16 : 8
// 注：严格判定应为 mdat box 自身大小超出 32-bit (mdat_data_total + 8 > 0xFFFFFFFF)。
// 此处用文件总大小做保守估计，多覆盖一小段安全区，不影响正确性。

// 第二遍：用确定的 mdat_header_size 计算最终值
// mdat_data_start = sample 数据在文件中的绝对起始偏移（已含 mdat box header），即 co64 应指向的 chunk 偏移
mdat_data_start = ftyp_size + moov_size + mdat_header_size
                = 20 + (559 + 4N) + mdat_header_size
mdat_size = mdat_header_size + mdat_data_total
total_file_size = ftyp_size + moov_size + mdat_size
```

**关键差异：**

- ISOBMFF 不需要 AVI 的 WORD 对齐填充
- mdat 内 sample 间零间隙，sample_prefix[i] 给出 sample[i] 相对于 mdat_data_start 的偏移
- co64 仅 1 条记录 = 24B，与帧数无关
- 每帧开销仅 4B（一条 stsz 条目），帧 0 和末帧不填充

### 边界情况

- 空文件列表: fileTotalData = 0 时 totalFrames = 1（仅元数据帧）。实际场景不出现。
- 元数据超限: frame0EncData > w × h × 4 时抛错（判断元数据加密区是否超出一帧图像容量；帧 0 总大小 = 28B 明文头 + frame0EncData）。
- 空数据文件: file.size = 0 的文件占一个 fileEntry，不产生数据帧。
- **大文件**：co64 64-bit 偏移 + mdat largesize 机制，文件大小无上限（实际受浏览器 Blob 限制）。

---

## 编码流程

### Box 构建（预计算阶段）

```
function buildMP4Boxes(frameInfo, w, h, fps):
  N = frameInfo.totalFrames

  // mdat 数据量
  mdat_data_total = sample0_size + Σ_{i=1}^{N-1} frames[i].dataSize
  mdat_header_size = (total_file_size_est > 0xFFFFFFFF) ? 16 : 8

  moov_size = 559 + 4 × N
  mdat_data_start = 20 + moov_size + mdat_header_size

  // 构建所有 box buffer
  ftyp_buf    = buildFTYP()
  mvhd_buf    = buildMVHD(fps × 1000, N × 1000)
  tkhd_buf    = buildTKHD(N × 1000, w, h)
  mdhd_buf    = buildMDHD(fps × 1000, N × 1000)
  hdlr_buf    = buildHDLR()
  vmhd_buf    = buildVMHD()
  dref_buf    = buildDREF()
  stsd_buf    = buildSTSD(w, h)
  stts_buf    = buildSTTS(N, 1000)
  stsc_buf    = buildSTSC(N)          // N samples（含帧 0） → 1 chunk
  stsz_buf    = buildSTSZ(frameInfo)  // N entries, 每帧精确大小
  co64_buf    = buildCO64_single(mdat_data_start)  // 1 entry

  mdat_hdr    = buildMDATHeader(mdat_data_total, mdat_header_size)

  // 容器 box
  dinf_size = 8 + dref_buf.length
  stbl_size = 8 + stsd_buf.length + stts_buf.length + stsc_buf.length
            + stsz_buf.length + co64_buf.length
  minf_size = 8 + vmhd_buf.length + dinf_size + stbl_size
  mdia_size = 8 + mdhd_buf.length + hdlr_buf.length + minf_size
  trak_size = 8 + tkhd_buf.length + mdia_size
  moov_actual = 8 + mvhd_buf.length + trak_size

  // 防御性断言：所有 box 大小经手工推导校验，实现时保留此断言以捕获笔误
  assert(moov_actual === 559 + 4 * N, "moov size mismatch")

  dinf_hdr = buildBoxHeader(dinf_size, 'dinf')
  stbl_hdr = buildBoxHeader(stbl_size, 'stbl')
  minf_hdr = buildBoxHeader(minf_size, 'minf')
  mdia_hdr = buildBoxHeader(mdia_size, 'mdia')
  trak_hdr = buildBoxHeader(trak_size, 'trak')
  moov_hdr = buildBoxHeader(moov_actual, 'moov')

  return {
    ftyp_buf, moov_hdr, mvhd_buf, trak_hdr, tkhd_buf,
    mdia_hdr, mdhd_buf, hdlr_buf, minf_hdr, vmhd_buf,
    dinf_hdr, dref_buf, stbl_hdr, stsd_buf, stts_buf,
    stsc_buf, stsz_buf, co64_buf, mdat_hdr,
    mdat_data_start, mdat_data_total
  }
```

### 流式写入（ReadableStream 串行）

```
push(ftyp_buf)
push(moov_hdr) → mvhd_buf
push(trak_hdr) → tkhd_buf
push(mdia_hdr) → mdhd_buf → hdlr_buf
push(minf_hdr) → vmhd_buf
push(dinf_hdr) → dref_buf
push(stbl_hdr) → stsd_buf → stts_buf → stsc_buf → stsz_buf → co64_buf
// ── moov 结束 ──
push(mdat_hdr)           // 8B 标准或 16B largesize
// ── sample 0: 帧 0 (精确, 不填充) ──
push(28B 明文头)          // magic + encMagic + frameSalt + iter
push(加密元数据)          // AES-CTR(fileCount + fileEntries)
// ── sample 1..N-1: 满数据帧 ──
for i = 1 .. N-2:                                     // 除末帧外的所有数据帧（N=2 时为空循环，直接进入末帧）
  push(chunked 加密文件数据 × w×h×4 字节)
// ── sample N-1: 末帧 (精确, 不填充) ──
push(chunked 加密文件数据 × rem 字节)
// ── 无需 indx chuk、无需 WORD 对齐 ──
closeStream()
```

### 流式加密（帧 0）

与 CRAFT-1 相同：

```
frameSalt = random(16)
key = PBKDF2(password, frameSalt, iter)
encMagic = AES-CTR("F2V1", key, frameSalt, 0, 128)[0..3]

metaPlain = fileCount_BE(8) + fileEntries
encrypted = AES-CTR(metaPlain, key, frameSalt, 1, 128)

push(28B 明文头)
push(encrypted)

cumulative = metaPlain.length
```

### 流式加密（帧 1..N）

与 CRAFT-1 相同，chunked AES-CTR 带 prePad 对齐：

```
blockOff = 1 + floor(cumulative / 16)
prePad = cumulative % 16

while data remaining:
  chunk = readFileDataRange(files, frameDataOff + offset, CHUNK)
  aligned = ceil((prePad + chunk.length) / 16) × 16
  padded = new Uint8Array(aligned)
  padded.set(chunk, prePad)
  encrypted = AES-CTR(padded, key, frameSalt, blockOff, 128)
  push(encrypted.subarray(prePad, prePad + chunk.length))
  cumulative += chunk.length
  blockOff = 1 + floor(cumulative / 16)
  prePad = cumulative % 16
```

> **JS 实现注意：** `cumulative` 和 `blockOff` 的计算依赖整数精度。本设计目标文件规模在 TB 级以下（≤ 10TB），`Number` 安全整数上限 2⁵³ ≈ 9PB 充分安全。若未来扩展到 PB 级，需切换为 `BigInt`。

---

## 解码流程

### 1. 解析 ISOBMFF 容器

```
parseMP4(blob):
  // ftyp 验证
  buf = read(blob, 0, 20)
  assert(buf[4..7] == 'ftyp')

  // 遍历顶层 box（处理 largesize）
  off = 20
  while off < blob.size:
    hdr = read(blob, off, 8)
    box_size = BE32(hdr, 0)
    box_type = ASCII(hdr, 4, 4)

    if box_size == 1:
      box_size = Number(readBigUint64(blob, off + 8))   // largesize
      header_size = 16
    else if box_size == 0:
      box_size = blob.size - off
      header_size = 8
    else:
      header_size = 8

    if box_type == 'moov':  parseMOOV(blob, off + header_size, off + box_size)
    if box_type == 'mdat':  mdat_data_start = off + header_size   // 记录 mdat 数据起始偏移，与 co64[0] 做一致性校验
    off += box_size
```

### 2. 解析 moov → stbl

```
parseSTBL(blob, start, end):
  ...
  if type == 'stsd':
    format = ASCII(read(blob, off+20, 4))   // assert == 'raw '
    w = BE16(read(blob, off+48, 2))
    h = BE16(read(blob, off+50, 2))
  if type == 'stsz':
    sample_count = BE32(read(blob, off+16, 4))
    stsz = []
    for i in 0..sample_count-1:
      stsz[i] = BE32(read(blob, off+20 + i×4, 4))
  if type == 'co64':
    entry_count = BE32(read(blob, off+12, 4))  // assert == 1
    mdat_base = readBigUint64(blob, off+16)     // 唯一的 chunk 偏移
  ...
```

### 3. 计算帧偏移（stsz 前缀和）

由于 co64 只有 1 条记录，所有 sample 共享同一起始偏移。sample[i] 的绝对文件偏移通过 stsz 前缀和计算：

```
// stsz 为 32-bit，但前缀和累加可能超出 32-bit；sample_offsets 用 64-bit 整数
sample_offsets[0] = mdat_base                       // mdat_base 来自 co64 (64-bit)
for i = 1 .. sample_count-1:
  sample_offsets[i] = sample_offsets[i-1] + stsz[i-1]

rawFrames[0] = { absOffset: sample_offsets[0], size: stsz[0] }
for i = 1 .. sample_count-1:
  rawFrames[i] = { absOffset: sample_offsets[i], size: stsz[i] }

metaFrame = rawFrames[0]
dataFrames = rawFrames[1..]
totalFrames = sample_count
```

此处的 O(N) 前缀和是一次性初始化开销。10 万帧下约 40 万次整數加法，毫秒级完成。

### 4. 读帧 0

**与 CRAFT-1 完全相同。** 从 `metaFrame.absOffset` 处读取 `metaFrame.size` 字节（精确大小，例如 228B），前 28B 为明文头，后续为 AES-CTR 加密区。解密后得到 fileCount + fileEntries。

```
cumulativeEncrypted = frame0EncData   // 帧 0 加密区字节数，供后续数据帧解密时接续 counter
```

### 5. 读帧 1..N

**与 CRAFT-1 相同，** 但帧偏移来自 stsz 前缀和而非 co64/indx：

```
for each dataFrame in dataFrames:
  raw = read(blob, dataFrame.absOffset, dataFrame.size)

  blockOff = 1 + floor(cumulativeEncrypted / 16)
  prePad = cumulativeEncrypted % 16
  alignedLen = ceil((prePad + raw.length) / 16) × 16

  padded = new Uint8Array(alignedLen)
  padded.set(raw, prePad)
  decrypted = AES-CTR(padded, key, frameSalt, blockOff, 128)

  plainChunk = decrypted.subarray(prePad, prePad + raw.length)

  cumulativeEncrypted += raw.length
```

### 6. 文件数据提取

与 CRAFT-1 相同的线性偏移模型：建立全局文件偏移表后，对每个文件的字节区间映射到覆盖它的帧区间，逐帧 AES-CTR 对齐解密后拼接。

---

## 无损提取验证

ISOBMFF 的无损提取保证：

| 保证           | 机制                                                                  |
| -------------- | --------------------------------------------------------------------- |
| 字节精确       | stsz 记录每个 sample 的精确字节数，帧 0 和末帧不填充                  |
| 无对齐破坏     | ISOBMFF 无 WORD/DWORD 对齐要求，sample 间零间隙                       |
| 无颜色空间转换 | FourCC=`raw ` + depth=32 + 编解码双方约定 BGRA                        |
| 无容器层修改   | mdat 中的字节按原始顺序写入、按原始顺序读取                           |
| 前缀和精度     | stsz 均为 32-bit，前缀和用 64-bit（或 BigInt）累加，防止 N 极大时溢出 |

**验证方式（编码后自检）：**

1. `Σ stsz[i] == mdat_data_total` — sample 大小之和等于 mdat 数据总量
2. `sample_offsets[i] == sample_offsets[i-1] + stsz[i-1]` — sample 间无间隙
3. 解码端输出的 framebuffer 与编码端输入的 framebuffer 逐字节比对一致
4. co64[0] + mdat_data_total == 文件末尾 — 无尾随垃圾数据

**编码后自检流程：** 编码器写入完毕后，用同一进程内的解码路径读取自身输出，逐项执行上述 4 项检查。全部通过后删除源临时文件（如有），任一项失败则保留现场（中间产物 + 最终文件）便于排查。此流程同时验证编解码对齐和容器完整性。

---

## 元数据分布

| 信息          | 存放位置                        |
| ------------- | ------------------------------- |
| 魔数 F2V1     | sample[0] 明文 0..3             |
| encMagic      | sample[0] 明文 4..7             |
| frameSalt     | sample[0] 明文 8..23            |
| PBKDF2 迭代数 | sample[0] 明文 24..27           |
| 分辨率 w/h    | tkhd width/height               |
| 帧率 fps      | mvhd timescale / 1000           |
| 帧偏移        | stsz 前缀和 (co64 提供基准偏移) |
| 帧大小        | stsz                            |
| 帧总数        | stsz.sample_count               |
| chunk 布局    | stsc (N samples → 1 chunk)      |
| 文件总数      | sample[0] 加密区 0..7           |
| 文件条目      | sample[0] 加密区 8..            |
| 文件数据      | sample[1..N] 加密区，连续贯穿   |

---

## 与 CRAFT-1 的代码迁移映射

| CRAFT-1 函数/常量     | CRAFT-2 对应            | 说明                                 |
| --------------------- | ----------------------- | ------------------------------------ |
| `buildAVIIndex()`     | `buildMP4Boxes()`       | 预计算所有 box buffer，co64 仅 1 条  |
| `writeAVIHeader()`    | `writeMP4Header()`      | 流式写入 ftyp + moov 所有 box        |
| `writeChunkHeader()`  | **删除**                | ISOBMFF sample 无 header             |
| `writeINDX()`         | **删除**                | 索引在 stsz 前缀和中                 |
| `parseAVI()`          | `parseMP4()`            | 遍历 box 层次替代 RIFF LIST 遍历     |
| `AVIF_HASINDEX`       | **删除**                | 无对应概念                           |
| WORD 对齐 `push([0])` | **删除**                | ISOBMFF 无对齐要求                   |
| 帧偏移计算            | `parseAVI` 的 indx 定位 | stsz 前缀和 (初始化 O(N)，之后 O(1)) |
| `video/avi` MIME      | `video/mp4`             | Content-Type                         |
| `.avi` 文件扩展名     | `.mp4`                  | 文件名                               |

**不变的部分：**

- `precomputeFrames()` — 帧布局预计算
- `prepareIndexParams()` — 加密参数准备
- `encodeFrame0()` — 帧 0 加密写入（不需要填充）
- `encodeDataFrame()` — 数据帧加密写入（末帧精确大小）
- `readFrame0()` — 帧 0 读取解密
- `extractFileData()` / `extractFileDataRange()` — 文件数据提取
- `deriveEncKey()` / `aesEncrypt()` / `aesDecrypt()` — 全部加密原语
- `FRAME0_HEADER_SIZE`, `F2V1`, `BPP` — 全部常量
