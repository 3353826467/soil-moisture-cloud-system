/* ============================================================
 * AI 后端配置 · 模板
 * ------------------------------------------------------------
 * 用法：复制为 config.js 后填写自己的密钥（config.js 已被 .gitignore 排除，
 *       不会进版本库）。也可以完全不建 config.js，改用环境变量：
 *         AI_API_BASE / AI_API_KEY / AI_MODEL / PORT
 * ============================================================ */
module.exports = {
  /* 服务端口 */
  port: 8080,

  /* 静态站点根目录（相对本文件），指向前端 web/ */
  webRoot: '../web',

  ai: {
    /* 上游接口（OpenAI 兼容）。DeepSeek 官方两种写法都可用：
     *   https://api.deepseek.com            → 自动补 /chat/completions
     *   https://api.deepseek.com/v1         → 自动补 /chat/completions
     */
    base: 'https://api.deepseek.com',
    /* API Key：只存在于服务端，前端永远拿不到 */
    key: '',
    /* 模型名 */
    model: 'deepseek-flash',
    /* 默认温度（前端可在 0~1 内覆盖） */
    temperature: 0.3,
    /* 单次回答的最大 token（推理型模型会先消耗一批思维链 token，别设太小） */
    maxTokens: 4096,
    /* 上游超时（毫秒） */
    timeoutMs: 120000
  },

  /* 同时打到上游的最大并发请求数，超了直接返回 429，避免密钥被刷爆 */
  maxConcurrent: 4,
  /* 单 IP 每分钟请求上限（0 = 不限） */
  perIpPerMinute: 30
};
