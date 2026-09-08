import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type AssistantError = {
  stopReason?: unknown;
  errorMessage?: unknown;
};

type RetryMatcher = (message: AssistantError, contextWindow?: number) => boolean;
type RetryMethod = (this: unknown, message: AssistantError) => boolean;
type RetryPatchState = {
  original: RetryMethod;
  matcher?: RetryMatcher;
};
type RetryErrorsConfig = {
  errors?: unknown;
};

const CONFIG_FILE = "retry-errors.json";
const PATCH_STATE = Symbol.for("pi.retry-errors.patch.v1");
const MAX_RETRY_ERRORS = 200;
const MAX_ERROR_LENGTH = 2000;
const NON_RETRYABLE_ERRORS = [
  "insufficient quota",
  "insufficient_quota",
  "quota exceeded",
  "out of budget",
  "billing",
  "payment required",
  "authentication",
  "unauthorized",
  "forbidden",
  "invalid api key",
  "context length",
  "context window",
  "too many tokens",
] as const;

function normalizeError(value: string): string {
  return value
    .trim()
    .replace(/^error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function uniqueErrors(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeError).filter(Boolean))];
}

function sanitizeErrors(values: readonly string[]): string[] {
  return uniqueErrors(values.map((value) => value.slice(0, MAX_ERROR_LENGTH))).slice(0, MAX_RETRY_ERRORS);
}

function globalConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
  return join(agentDir, CONFIG_FILE);
}

function bundledConfigPath(): string | undefined {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..", CONFIG_FILE);
  } catch {
    return undefined;
  }
}

function readRetryErrors(): { errors: string[]; error?: string } {
  const userPath = globalConfigPath();
  // 优先使用用户级配置；不存在时读取包内随附的初始配置。
  const path = existsSync(userPath) ? userPath : bundledConfigPath();
  if (!path || !existsSync(path)) return { errors: [] };

  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as RetryErrorsConfig;
    if (!Array.isArray(config.errors)) {
      return { errors: [], error: `${CONFIG_FILE} 的 errors 必须是数组` };
    }

    const errors = sanitizeErrors(
      config.errors.filter((value): value is string => typeof value === "string"),
    );
    return { errors };
  } catch (error) {
    return { errors: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function writeRetryErrors(errors: readonly string[]): void {
  const path = globalConfigPath();
  const tempPath = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify({ errors: sanitizeErrors(errors) }, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function isRetryableConfiguredError(
  message: AssistantError,
  patterns: readonly string[],
  contextWindow = 0,
): boolean {
  if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
  if (isContextOverflow(message as Parameters<typeof isContextOverflow>[0], contextWindow)) return false;

  const normalized = normalizeError(message.errorMessage);
  if (!normalized || NON_RETRYABLE_ERRORS.some((pattern) => normalized.includes(pattern))) return false;
  return patterns.some((pattern) => normalized.includes(pattern));
}

function installRetryMatcher(matcher: RetryMatcher): { installed: boolean; deactivate: () => void } {
  const prototype = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
  let state = prototype[PATCH_STATE] as RetryPatchState | undefined;

  if (!state) {
    const original = prototype._isRetryableError;
    if (typeof original !== "function") return { installed: false, deactivate: () => undefined };

    state = { original: original as RetryMethod };
    Object.defineProperty(prototype, PATCH_STATE, {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    // 复用 Pi 原生预算、退避、取消和事件流，只扩展错误分类结果。
    Object.defineProperty(prototype, "_isRetryableError", {
      configurable: true,
      enumerable: false,
      value: function (this: unknown, message: AssistantError): boolean {
        const contextWindow = typeof this === "object" && this !== null && "model" in this
          ? Number((this as { model?: { contextWindow?: unknown } }).model?.contextWindow) || 0
          : 0;
        return state!.original.call(this, message) || Boolean(state!.matcher?.(message, contextWindow));
      },
      writable: true,
    });
  }

  state.matcher = matcher;
  return {
    installed: true,
    deactivate: () => {
      if (state?.matcher === matcher) state.matcher = undefined;
    },
  };
}

function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, type);
}

function latestAssistantError(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.stopReason !== "error" || typeof entry.message.errorMessage !== "string") continue;
    return entry.message.errorMessage;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let retryErrors: string[] = [];
  let lastConfigError: string | undefined;

  const reloadPatterns = () => {
    const loaded = readRetryErrors();
    retryErrors = loaded.errors;
    lastConfigError = loaded.error;
  };

  reloadPatterns();
  const matcher: RetryMatcher = (message, contextWindow) =>
    isRetryableConfiguredError(message, retryErrors, contextWindow);
  const patch = installRetryMatcher(matcher);

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error" || typeof message.errorMessage !== "string") return;

    const trimmed = message.errorMessage.trim();
    if (trimmed === message.errorMessage) return;
    return { message: { ...message, errorMessage: trimmed } };
  });

  pi.on("session_start", async (_event, ctx) => {
    reloadPatterns();
    if (!patch.installed) {
      notify(ctx, "retry-errors 与当前 Pi 版本不兼容：未找到原生重试判定函数。", "error");
    } else if (lastConfigError) {
      notify(ctx, `retry-errors 配置读取失败: ${lastConfigError}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    patch.deactivate();
  });

  pi.registerCommand("retry-errors", {
    description: "管理配置文件中的自动重试异常文本",
    handler: async (args, ctx) => {
      const input = args.trim();
      const separator = input.indexOf(" ");
      const command = (separator === -1 ? input : input.slice(0, separator)).toLowerCase();
      const value = separator === -1 ? "" : input.slice(separator + 1).trim();

      if (!command || command === "list") {
        const configured = retryErrors.length > 0
          ? retryErrors.map((error) => `- ${error}`).join("\n")
          : "- （无）";
        notify(ctx, `配置中的自动重试异常 (${retryErrors.length}):\n${configured}`);
        return;
      }

      if (command === "reload") {
        reloadPatterns();
        notify(
          ctx,
          lastConfigError ? `配置读取失败: ${lastConfigError}` : `已重新加载 ${retryErrors.length} 条异常配置。`,
          lastConfigError ? "warning" : "info",
        );
        return;
      }

      if (command === "reset") {
        try {
          writeRetryErrors([]);
          reloadPatterns();
          notify(ctx, "已清空配置文件中的自动重试异常。");
        } catch (error) {
          notify(ctx, `写入失败: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      const addError = (source: string) => {
        const normalized = normalizeError(source).slice(0, MAX_ERROR_LENGTH);
        if (!normalized) {
          notify(ctx, "异常文本不能为空。", "warning");
          return;
        }
        if (NON_RETRYABLE_ERRORS.some((pattern) => normalized.includes(pattern))) {
          notify(ctx, "认证、配额、计费或上下文溢出错误不会加入自动重试。", "warning");
          return;
        }
        if (retryErrors.includes(normalized)) {
          notify(ctx, `异常文本已经存在: ${normalized}`, "warning");
          return;
        }
        if (retryErrors.length >= MAX_RETRY_ERRORS) {
          notify(ctx, `配置中的自动重试异常最多 ${MAX_RETRY_ERRORS} 条。`, "warning");
          return;
        }
        try {
          writeRetryErrors([...retryErrors, normalized]);
          reloadPatterns();
          notify(ctx, `已追加异常文本: ${normalized}`);
        } catch (error) {
          notify(ctx, `写入失败: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      };

      if (command === "add-last") {
        const error = latestAssistantError(ctx);
        if (!error) {
          notify(ctx, "当前会话没有可追加的助手异常。", "warning");
          return;
        }
        addError(error);
        return;
      }

      if (command === "add") {
        addError(value);
        return;
      }

      if (command === "remove") {
        const normalized = normalizeError(value);
        const next = retryErrors.filter((error) => error !== normalized);
        if (next.length === retryErrors.length) {
          notify(ctx, `未找到配置中的异常文本: ${normalized || "（空）"}`, "warning");
          return;
        }
        try {
          writeRetryErrors(next);
          reloadPatterns();
          notify(ctx, `已移除异常文本: ${normalized}`);
        } catch (error) {
          notify(ctx, `写入失败: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      notify(ctx, "用法: /retry-errors list | add-last | add <异常文本> | remove <异常文本> | reload | reset", "warning");
    },
  });
}
