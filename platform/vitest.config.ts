import { defineConfig } from "vitest/config";

// 单测只测纯函数（解析器 + 计算），不需要 Workers 运行时
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
