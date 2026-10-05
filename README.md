# Recordly MCP Server

基于MCP编辑 **Recordly工程副本**：剪掉已经审核的口误/长停顿/重说区间，修改或删除已有缩放效果，并把工程保存到软件可以直接列出的Projects目录。

这是非官方兼容工具，不是Recordly官方MCP。基于 [ClipAgent](https://github.com/DharambirAgrawal/clip-agent) 的MCP代码改造，原软件来自 [Recordly](https://github.com/webadderallorg/Recordly)；来源、修改及许可证见 [NOTICE.md](NOTICE.md) 和 [LICENSE.md](LICENSE.md)。

## 安装

需要Node.js 20+。媒体分析需要系统FFmpeg和ffprobe；工程读写本身不需要它们。

```sh
git clone https://github.com/AzenYes/recordly-mcp-server.git
cd recordly-mcp-server
npm ci
npm run build
npm test
```

在Codex的MCP配置中添加：

```toml
[mcp_servers.recordly]
command = "node"
args = ["C:/tools/recordly-mcp-server/dist/index.js"]
```

将路径替换为实际克隆位置，重连MCP。其他支持stdio的客户端可使用相同command和args。

默认解析Recordly的用户数据目录，支持 `recordings-settings.json` 中的自定义recordingsDir。可选环境变量：`RECORDLY_USER_DATA_DIR`、`FFMPEG_PATH`、`FFPROBE_PATH`。

## 工具

| 工具 | 能力 |
| --- | --- |
| get_paths | 返回实际录制目录和Projects目录 |
| list_projects / open_project | 列出工程、读取完整状态与revision |
| copy_project | 在Projects创建不覆盖原文件的新副本 |
| get_media_info / detect_silence / scan_frames | 查看素材、检测停顿候选、抽查源画面 |
| cut_ranges | 将已审核的源时间区间从现有clipRegions中剪除，返回成片时间映射 |
| list_zooms | 读取已有缩放的ID、时间、深度、焦点 |
| update_zoom | 修改单个缩放的倍率档位、焦点、时间、自动/手动模式 |
| delete_zooms | 按ID或区间删除已有缩放，不删除录屏内容 |

剪切及缩放写入支持 `dryRun`、`expectedRevision` 和工程旁 `.mcp-backups` 备份。所有时间单位均为**源视频毫秒**，不是剪辑后成片时间。先保存并关闭编辑器中的对应副本，再让MCP写入，完成后重开；原软件不遵守MCP内部的写入锁。

```json
{"project":"demo_粗剪","timelineModel":"recordly-1.4-source-time","ranges":[{"startMs":20000,"endMs":26000}],"dryRun":true}
```

```json
{"project":"demo_粗剪","zoomIds":["实际缩放ID"],"dryRun":true}
```

## 实测与兼容边界

- 工程编辑接口已在Windows Recordly **1.4.0** 实测；测试媒体不随仓库公开。
- `cut_ranges`只支持已验证的version=2、单源、1倍速、按源时间排序的clipRegions。不同软件版本也可能使用version=2；调用方仍必须确认实际时间轴语义。检测到 `sourceStartMs`、变速或与保留区间冲突的trimRegions时拒绝写入；接受原生保存时生成的冗余trim-gap镜像。
- 时间轴中被剪掉的位置仍显示为空隙，原生导出会接起保留片段。不要拖动片段填空，以免改变源区间。
- 没有内置“识别口误”或“检测晃动”AI；调用方需要审核剪切和缩放修改区间。
- 本MCP不提供成片渲染接口；修改完成后可使用Recordly原生导出。

## 验证

```sh
npm test
```

Node测试使用真实stdio MCP客户端和合成工程，验证备份、并发写入、版本保护、未知字段保留、Projects落盘、剪切映射与音轨设置。
