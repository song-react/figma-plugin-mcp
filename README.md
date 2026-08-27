# Local Figma MCP

该服务通过当前 Figma 文件中的开发插件直接调用 Plugin API，不使用官方 MCP、REST API 或 Personal Access Token。

## 一次性安装

1. Figma 菜单选择 `Plugins → Development → Import plugin from manifest…`。
2. 选择 `/Users/apple/.codex/figma-plugin-mcp/plugin/manifest.json`。
3. 在需要读取的文件中运行 `Plugins → Development → Local Figma MCP Bridge`，并保持插件面板开启。
4. 完全退出并重新打开 Codex，使新增的 `figma_local` MCP 生效。

常驻桥接由 launchd 自动启动，健康状态：`http://127.0.0.1:18428/`。

命令行也可直接验证或读取：

```bash
bun cli.mjs figma_list_sessions
bun cli.mjs figma_get_selection '{"depth":6}'
```

## 提供的工具

- `figma_list_sessions`
- `figma_get_selection`
- `figma_get_current_page`
- `figma_get_node`
- `figma_find_nodes`
- `figma_get_variables`
- `figma_export_node`
- `figma_export_selection`

SVG 由 Figma 原生 `SVG_STRING` 导出；PNG/JPG/PDF 使用原始二进制导出，透明背景由目标节点本身决定。
