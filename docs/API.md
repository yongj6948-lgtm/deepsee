# screencye MCP — API 参考与运行约束

Version 0.1.0 · Updated with R1–R6 improvements · upload_file / server_info / --bridge · 并发加固

## 1. 传输方式

| 模式 | 启动方式 | 用途 |
|---|---|---|
| stdio | `screencye-mcp`（无参数） | Claude Code / Hermes 等本地 MCP 客户端 |
| HTTP | `screencye-mcp --http --port 8787` | 远程/移动 agent（OpenMinis 等），Streamable HTTP 于 `POST /mcp` |
| **bridge** | `screencye-mcp --bridge --server http://OCR主机:8787` | **宿主导伴进程**：在持有截图的机器上跑 stdio MCP，读本地真实文件并流式上传到远端 /upload，图片字节全程不进模型上下文 |

HTTP 模式额外端点：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/mcp` | POST | MCP JSON-RPC（Streamable HTTP，JSON 响应） |
| `/upload` | POST | multipart 表单，字段 `file`；**流式落盘**（边收边写，内存 O(边界)），返回 `{ok, path, name, size}`，`path` 为**服务器本地路径** |
| `/` | GET | 存活检查 |

## 2. 工具

### `decode_screenshot`
- **输入** `path`：图片来源，三选一：
  1. **文件路径**——注意：是 **MCP 服务器主机**上的路径，不是调用方设备上的路径
  2. **data URI**：`data:image/png;base64,....`（≤ 25 MB）
  3. **http(s) URL**：由服务器端下载（≤ 25 MB，60s 超时）
- **输出**：结构化转录文本 + 末尾 `META:` JSON 行（见 §4）

### `decode_screenshot_base64`
- **输入** `data`：base64 字节（裸 base64 或 data URI），可选 `filename`
- 与 `decode_screenshot` 等价，仅传输方式不同
- **限制**：协议层无大小上限（HTTP body 传输），但通过 **shell CLI 调用时 argv 单参数约 128 KB**——大 payload 必须用 `minis-mcp-cli call ... --input-file <path>`（见 §6）或 `/upload` + `decode_screenshot`

### `upload_file`（新，模型侧一等公民）
- **输入**：`path` ｜ `data`(base64/data URI) ｜ `url` 三选一，可选 `filename`
- **行为**：把图片**复制进服务器 upload store**（允许根目录），返回稳定的服务器端 `path`，供 `decode_screenshot`/`describe_screenshot` 复用；后续 decode 不再需要重复传字节
- **语义**：`path` 同样只解析服务器主机；本机文件请用 `data` 或 host 侧 `--bridge`
- 对应 HTTP 层的 `/upload`（curl -F），供**模型通过 MCP 直接触达**，不必退而求其次去内联 base64

### `describe_screenshot`
- **输入** `path`：同 `decode_screenshot`（路径 / data URI / URL）
- **输出**：Top-5 语义标签（MobileCLIP2-S2，~96 类）+ 分数；低于阈值时附 LOW CONFIDENCE 警告

### `server_info`（新，诊断）
- **输入**：可选 `check_url`（URL 连通性探测）、`echo`（往返校验+测延迟）
- **输出**：版本/传输方式/主机 LAN IP；服务器**可读根目录**（upload store、temp、任意服务器路径）；模型加载情况；大小/并发上限；`check_url` 的明确 YES/NO + 状态码/字节/耗时
- **何时用**：遇到 `file not found on server` 或 `fetch failed` 时先调它，省掉反复试错

## 3. 输入约束

| 项 | 约束 |
|---|---|
| 图片格式 | PNG / JPG / WebP（data URI 按 MIME 推断，文件按扩展名，URL 按路径扩展名） |
| payload 上限 | 25 MB（URL / base64）；`/upload` 与 `upload_file` 上限 `--max-upload-bytes`（默认 256 MB，**流式**落盘） |
| 分辨率 | 无硬上限；**> 1600px 自动分块 OCR**（tile ≤ 1600px，重叠 40px，上限 16 块），`META.tiles > 1` 即分块生效 |
| 布局分析 | 像素分析在 ≤ 1400px 的确定性降采样图上进行（坐标已映射回原图） |

## 3.5 并发与资源约束（重要）

| 项 | 行为 |
|---|---|
| 上传并发 | 文件名带 `Date.now()+32bit随机`，**永不冲突**；字节流式写 `.partial` 后原子 rename，并发 decode **读不到半截文件** |
| 上传内存 | 流式落盘，峰值内存 O(边界长度)，与文件大小无关；超 `--max-upload-bytes` 返回 413 |
| 磁盘增长 | upload store 按 `--upload-ttl`（默认 6h）自动 GC 过期文件 |
| decode 并发 | `--max-parallel-decodes`（默认 2）信号量限流 CPU 密集的 OCR |
| 上传体积与代码路径 | decode_* 的 `path`/data/URL 上限 25 MB；需要更大图时经 `/upload` 或 `upload_file`（上限 256 MB） |

## 4. META 元数据（每次解码返回）

转录文本末尾追加一行（客户端可正则提取）：

```
META: {"input_size":{"width":3000,"height":2000},"decode_ms":2506,"ocr_ms":2116,"layout_ms":356,"load_ms":34,"model":"paddleocr-v5-mobile","ocr_confidence_avg":0.8704,"tiles":4}
```

| 字段 | 含义 | 排障用法 |
|---|---|---|
| `input_size` | 原图宽高 | 客户端压缩太狠时此处会很小 |
| `decode_ms` | 总耗时 | 整体延迟基线 |
| `ocr_ms` | OCR 阶段耗时 | 大图/分块时占比最高（数百 ms–数秒） |
| `layout_ms` | 布局/推断/转录耗时 | 像素 CV 部分（~100–400 ms） |
| `load_ms` | 图片加载耗时 | URL 下载/磁盘 IO 慢时显著 |
| `model` | OCR 模型标识 | 固定 `paddleocr-v5-mobile` |
| `ocr_confidence_avg` | 全部文字平均置信度（0–1） | **< 0.7 说明原图质量差（被压缩/降采样/模糊），应改用更高分辨率输入** |
| `tiles` | 分块数（1 = 未分块） | > 1 时 `ocr_ms` 上升属正常 |

判断链路：`ocr_confidence_avg` 低 → 输入图质量问题（客户端不要压缩）；`ocr_ms` 异常高 → 分辨率过大，可考虑客户端先按比例缩小到 ~1600–2400px。

## 5. 运行环境

- **纯 CPU**，零 GPU / 零网络依赖（URL 输入除外——由服务器端发起下载）
- 模型：PaddleOCR v5 mobile（~21 MB，ONNX Runtime）+ 可选 MobileCLIP2-S2（~70 MB）
- 典型耗时（单核/多核 CPU，AMD/Intel 现代 CPU）：
  - 1280×800 登录页：**~0.5–1.5 s**
  - 3000×2000 大图（分块 4 tiles）：**~2.5 s**
  - describe（MobileCLIP）：**~10–50 ms**
- 首次调用包含模型加载（~1–2 s），进程常驻后不再发生

## 6. 推荐调用路径（大图优先）

| 场景 | 推荐方式 |
|---|---|
| 图在服务器/本机（stdio） | `decode_screenshot(path)` 直接传路径 |
| 图在本机、OCR 在远端 | `screencye-mcp --bridge --server http://OCR主机:8787` —— path 即本机路径，自动上传+解码 |
| 图在服务器但想固化到存活区 | `upload_file(path|data|url)` 拿到稳定的服务器 path，再喂给 decode_* |
| 图在手机/远端设备 | 手机 sandbox 下载 `GET /static/screencye-cli.py`，然后 `python3 screencye-cli.py upload <file>`（一条命令：上传+解码，无大小限制） |
| 图在公网 URL | `decode_screenshot(path="https://...")` 或 `upload_file(url=...)` |
| 小图（< ~100 KB）且无网络 | `decode_screenshot_base64(data)` |
| 大 base64（无 CLI 限制） | `screencye-cli.py b64 <file>`（JSON body 传输）或 `/upload` |
| 遇到 file not found / fetch failed | 先调 `server_info(check_url=...)` 看可达性，再选上面路径 |

## 7. 部署位置与文件系统边界（重要）

- 服务运行在**部署它的主机**上（启动日志会打印 `host` 与 LAN IP）
- `decode_screenshot` 的 `path` **只解析服务器主机上的路径**——调用方设备的本地路径（如手机的 `/var/minis/browser/...`）**不存在于服务器**，会返回带根目录提示的 `file not found on server: ...`
- 服务器可见路径：
  - 该进程可读的任何服务器路径
  - `/upload`/`upload_file` 落盘目录：`--upload-dir`（默认 `os.tmpdir()/screencye-uploads`）
  - 临时解码文件：`os.tmpdir()/screencye-*`（用后即删）
- 手机/远端设备文件 → 必须经 `/upload`、`upload_file`、base64 或 URL 四种方式之一进入服务器

## 8. Host-side bridge（宿主导伴进程）

远程部署下，**宿主机 ↔ 远端 OCR 服务之间没有任何共享路径**。`--bridge` 把这不互通的两者焊起来：

```bash
# OCR 主机上：
screencye-mcp --http --port 8787
# 持有截图的机器上（本机 MCP 客户端指向它）：
screencye-mcp --bridge --server http://OCR主机:8787
```

bridge 提供与服务器同名工具，但 `decode_screenshot/describe_screenshot/upload_file` 的 `path` **指你的本机路径**：
- 首次调用 → 读本地文件 → 流式 POST 到远端 `/upload` → 拿返回的服务器路径 → 转发 decode
- 之后同一文件（按 size+mtime 判重）**直接命中缓存**，不重复上传；并发首次调用共享同一次上传（in-flight 去重）
- 图片字节全程走网络通道，**从不进入模型上下文**，base64/token 上限彻底消失
- 其余工具（`decode_screenshot_base64`、`server_info`）原样转发；`bridge_status` 显示上传缓存与远端可达性

## 9. 推荐排查顺序（新）

1. `server_info` — 确认可达、看可读根目录、`check_url` 探测你的 URL
2. 本机文件 → `upload_file`（HTTP 远端）或直接 `--bridge`（本地路径直达）；手机 → `screencye-cli.py upload`
3. 小图无网络 → `decode_screenshot_base64`
4. 仍失败 → 看 `META` 的 `ocr_confidence_avg` 判断是否是输入质量问题
