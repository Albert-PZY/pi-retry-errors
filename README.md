### pi-retry-errors

一个配置驱动的 Pi Coding Agent 全局异常自动重试扩展。

[![npm version](https://img.shields.io/npm/v/pi-retry-errors?logo=npm)](https://www.npmjs.com/package/pi-retry-errors) [![npm downloads](https://img.shields.io/npm/dm/pi-retry-errors?logo=npm)](https://www.npmjs.com/package/pi-retry-errors)
[![发布工作流](https://github.com/Albert-PZY/pi-retry-errors/actions/workflows/publish.yml/badge.svg)](https://github.com/Albert-PZY/pi-retry-errors/actions/workflows/publish.yml)

扩展复用 Pi 原生的重试预算、指数退避、取消机制和生命周期事件，仅补充配置文件中的异常文本识别。异常文本与扩展源码完全解耦。

### 功能

- 从 `retry-errors.json` 读取需要自动重试的异常文本。
- 自动去除异常消息首尾空格。
- 默认使用 Pi 的 `retry.maxRetries` 和 `retry.baseDelayMs`。
- 支持在会话中追加、移除和重新加载异常文本。
- 排除认证、权限、配额、计费和上下文溢出错误。
- 支持 TUI、JSON、Print 和 RPC 模式。

### 安装

从 npm 安装：

```bash
pi install npm:pi-retry-errors
```

或从 GitHub 安装：

```bash
pi install git:github.com/Albert-PZY/pi-retry-errors
```

版本页面：

- npm：<https://www.npmjs.com/package/pi-retry-errors>
- GitHub Packages 镜像：<https://github.com/users/Albert-PZY/packages/npm/package/pi-retry-errors>

安装完成后重新启动 Pi，或在当前 TUI 会话中执行：

```text
/reload
```

### Pi 重试配置

建议在 `~/.pi/agent/settings.json` 中使用单一的 agent-level 重试预算：

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 6,
    "baseDelayMs": 2000,
    "provider": {
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

以上配置会在首次请求失败后最多重试 6 次，退避时间依次为：

```text
2s, 4s, 8s, 16s, 32s, 64s
```

保留 `retry.provider.maxRetries: 0` 可以避免 provider SDK 与 Pi agent-level 重试叠加。

### 异常文本配置

仓库根目录的 `retry-errors.json` 提供初始配置。用户级配置路径为：

```text
~/.pi/agent/retry-errors.json
```

用户级配置存在时优先使用；不存在时使用包内配置。

配置格式：

```json
{
  "errors": [
    "terminated",
    "connection error",
    "upstream service temporarily unavailable",
    "upstream request failed",
    "upstream response stream was interrupted",
    "stream_read_error"
  ]
}
```

匹配时不区分大小写，会移除开头的 `Error:`，并合并多余空白字符。

### 会话命令

```text
/retry-errors list
/retry-errors add-last
/retry-errors add <异常文本>
/retry-errors remove <异常文本>
/retry-errors reload
/retry-errors reset
```

- `list`：显示当前生效的配置。
- `add-last`：把当前会话最近一次助手异常加入配置。
- `add`：手动追加异常文本。
- `remove`：移除异常文本。
- `reload`：重新读取配置文件。
- `reset`：清空用户级异常配置。

### 安全边界

扩展不会把以下错误加入自定义自动重试：

- 认证和权限错误。
- API key 无效。
- 配额、预算和计费错误。
- 上下文窗口或 token 数量溢出。

上下文溢出继续交给 Pi 原生 compaction 机制处理。

### 兼容性

当前实现针对 `@earendil-works/pi-coding-agent` `0.85.1` 验证。扩展会检查 Pi 的原生重试判定函数；若未来版本改变内部接口，会显示兼容性错误，而不是静默失效。

### 发布

先更新 `package.json` 中的版本号并提交，再推送同版本标签：

```bash
git tag v1.0.1
git push origin main v1.0.1
```

标签必须与 `package.json` 版本一致。GitHub Actions 会检查包内容并自动发布到 npm。

### License

MIT
