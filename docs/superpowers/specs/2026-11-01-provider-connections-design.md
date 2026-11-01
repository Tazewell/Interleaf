# 国内服务商预设与可靠模型刷新

用户要求：解决百炼模型能列出但生成 HTTP 400 的兼容性问题；成功刷新模型后只显示本次返回的模型，避免历史项误选；增加几个国内厂家和自定义入口。继续在现有 `dev` 工作区开发，不自动发布。

## 行为

- 连接表单提供 DeepSeek、阿里百炼、Kimi、智谱、MiniMax、自定义。预设填官方普通 API 地址与协议，不默认 Coding Plan。百炼默认北京地域并明确其它地域可用自定义；不把不同地域 Key 混用。官方地址须用官方文档核实。
- 服务商切换只修改草稿，清空输入框里的旧 Key；直到点击保存才生效。跨连接保存不携带旧模型/历史列表或沿用旧 Key；同一连接空 Key 保留原密钥。自定义仍支持 OpenAI/Anthropic 协议和任意合法地址。
- 模型列表成功后只使用该端点返回的 ID，不混入历史 APIModels；接口不提供列表或获取失败时，保留手动输入能力并显式显示列表失败。已保存的用途选择可以保留在输入框，但不伪造成当前可用的列表选项。输入框关闭浏览器的历史自动填充。
- 手动“刷新模型列表”真正访问上游，绕过五分钟缓存并使其它模型选择器失效；旧请求不能覆盖新刷新结果。请求失败不得显示陈旧列表冒充成功。地址/协议/Key 变化保持现有陈旧响应保护。
- 百炼仅在已验证的官方域名和兼容 API 路径上启用专属参数规则；不把原厂 DeepSeek/Kimi 等规则套到百炼转售模型或自定义中转。未确认支持的思考参数省略，使用模型默认值；有明确官方规则的模型按文档映射。SDK调用与直接HTTP body位置要区分。
- 安全诊断支持百炼顶层错误信封，只显示白名单参数名/分类，不返回原始上游文案或 Key/文档正文。不能用删除报错提示的方式伪装连接成功。

## 已有证据

用户诊断编号 `4fa10a72a64c45db67ea24b042d86dd6` 的脱敏日志显示：模型 vanchin/deepseek-v4.1-flash-1017、custom/openai、未经确认的 reasoning_effort=medium、HTTP400，且现有错误解析器没有提取出参数。日志本身不足以断言具体被拒参数；用户模型列表成功，不归因于未填Key或地址错误。

## 验证

TDD 覆盖预设草稿/保存/Key边界、刷新上游调用计数与过期请求、成功列表不含历史项、列表失败手动输入、百炼实际HTTP payload与脱敏错误。只用测试服务器和虚拟Key，不读取用户API密钥、不发付费探测。执行类型检查、相关测试、全量测试与构建；提供临时库预览手动验收。

## 官方配置依据

- DeepSeek: https://api-docs.deepseek.com/quick_start/agent_integrations/workbuddy/
- 百炼地址及地域: https://help.aliyun.com/zh/model-studio/base-url
- 百炼逐模型请求参数: https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- Kimi: https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi
- 智谱: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
- MiniMax: https://platform.minimax.cn/docs/api-reference/text-openai-api
