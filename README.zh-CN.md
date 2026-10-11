# DSH Usage Dashboard

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一款非官方的 DeepSeek Harness（DSH）用量与额度仪表板，显示在其官方右侧边栏中。

> **Preview 兼容性：** 面向 **DSH Preview `0.2.0-rc.2`** 与 Cordis `~4.0.4`。DSH 仍处于预发布阶段；本实验性社区插件不承诺兼容其他预览版本或未来的稳定版本。浏览器 UI 需要 DSH 0.2 的侧边栏 API。旧版传输回退机制无法使该 UI 兼容 DSH 0.1。

## 功能特性

- 提供商余额、额度与配额卡片，在打开时或由用户操作时刷新；无后台轮询，也不进行会产生计费的模型探测。
- 用量优先，凭据置于下方的可折叠区域；移动端布局与适合触控的控件。
- 英语、简体中文、繁体中文与日语 UI，遵循 DSH 语言设置，并以浏览器语言/英语作为回退。
- 获取、尝试、凭据更新与手动刷新的时间戳。刷新失败会保留上一次成功的快照及其时间戳。
- DSH Connection 认证与 Host/Origin 检查。凭据解析与提供商请求均在 DSH 服务器上执行。

## 提供商支持

| 提供商 | 当前行为 |
| --- | --- |
| OpenRouter | 额度/用量适配器；需要管理 API key |
| DeepSeek | 官方只读 `GET /user/balance`；余额显示 |
| Deepgram | 余额适配器；需要管理密钥、`projectId` 与 `balanceId` |
| Tavily | 用量适配器；`projectId` 可选 |
| ChatGPT / Codex | 规范化由服务器提供的用量来源；不自动登录或抓取 |
| OpenCode Go | 面向滚动、每周与每月窗口的实验性只读用量适配器 |
| Kilo、Serper、Brave | 实验性/不受支持；添加凭据不会启用获取 |

提供商 API 可能独立于 DSH 发生变化。离线夹具验证的是适配器行为，而非实时账户或端点。

## 从源码安装

请单独安装 DSH Preview `0.2.0-rc.2`。需要 Node.js 20 或更高版本。这是 GitHub 源码发布；该包未发布到 npm。

```sh
git clone https://github.com/yu-chun-kit/dsh-usage-dashboard.git
cd dsh-usage-dashboard
npm ci
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-usage-dashboard
```

将最后的路径替换为你所克隆仓库的绝对路径，并将 `web` 替换为你的 DSH profile 名称。重启该 profile 的 DSH Web 进程，重新加载浏览器，然后从右侧边栏指南中选择 **Usage dashboard**。可在启动前使用 `dsh web --dump-config` 检查组合后的配置。

## 凭据与隐私

请使用 DSH 凭据管理，或在其凭据存储可写时使用已认证的仪表板。切勿将凭据放入 `cordis.patch.yml`、源文件、Git、截图、问题报告或命令行参数中。

| 引用 | 提供商 |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `DEEPGRAM_API_KEY` | Deepgram |
| `TAVILY_API_KEY` | Tavily |
| `OPENCODE_GO_API_KEY` | OpenCode Go |

已知的 DSH Models API key 记录（用于 OpenRouter、DeepSeek 与 OpenCode Go）也可在服务器上复用。显式引用优先。OAuth 授权与任意记录不会被解释。

设置会返回引用名称、布尔型配置/写入状态、已知来源标签与时间戳。密钥值与部分密钥预览绝不会返回。密码输入框在成功保存后会清空。写入仅接受已声明的引用以及不含换行符的 8–4096 个字符。

快照仅保存在内存中。DSH `dsh-usage-dashboard/activity` 记录仅存储允许的引用名称、时间戳与刷新结果，不含密钥或提供商快照。若无记录 API，活动仅保存在内存中，重启后即消失。早期事件、外部环境变更与原始会话签发日期均无法重建。

公开错误使用固定消息。日志不包含凭据、提供商响应体与原始异常文本。操作系统临时目录中的尽力而为日志 `dsh-usage-dashboard-boot.log` 仅记录路由名称与注册结果；该文件可删除。

已认证用户可以看到账户用量与余额；分享截图时请将这些数字视为私密信息。仓库夹具包含合成数据。凭据、环境文件、日志与本地开发笔记已被排除在公开源码快照之外。仅靠忽略规则无法移除已提交到 Git 历史中的文件。

## 传输与边界

`/api/usage-dashboard/{snapshot,settings,settings-write,credential}` 下的精确路由复用 Connection 的浏览器会话与受信任主机围栏。若无 Connection，路由辅助函数仅允许回环请求。激活会等待 `webServer`、`connection` 与 `credentials`。移动端与桌面端使用相同的已认证同源 API。

旧版 `/usage-dashboard` RPC 仅为没有现代围栏的旧版 Connection 适配器保留。DSH 0.2 使用已认证的精确路由。本插件不会更改 Harness 的 agent 循环，也不会授予命令/工作区权限。

## 开发与验证

```sh
npm ci
npm test
npm run check
```

测试使用假凭据与离线的提供商/浏览器夹具。无需真实密钥、模型请求或外部 MCP 服务器。除非提供模块根目录，否则可选的已安装 DSH 契约检查会被跳过：

```sh
DSH_TEST_MODULE_ROOT=/absolute/path/to/dsh/node_modules node --test test/dsh-contract.test.mjs
```

该检查使用已安装的服务与夹具凭据，并禁止提供商流量；它不会加载实时 profile。兼容性面向本地已验证的 `0.2.0-rc.2` 安装，而非未来的版本。

编辑 `locales/{en,zh-Hans,zh-Hant,ja}.json` 与 `src/client/i18n.ts`，然后构建。构建过程会校验键/参数，并同步生成的字典与浏览器本地化代码。请勿直接编辑生成的本地化片段。其他 DSH UI 翻译属于它们各自的语言包。

## 许可证

[MIT](LICENSE)。本项目为社区项目，并非 DeepSeek 官方发布。
