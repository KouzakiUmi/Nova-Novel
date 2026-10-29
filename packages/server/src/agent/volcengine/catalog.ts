// 来源：dsh-volcengine-provider 0.2.8，MIT；保留套餐能力快照，不从名称推断能力。
export const VOLC_CATALOG = {
  "agent-plan": {
    "api": "anthropic-messages",
    "baseURL": "https://ark.cn-beijing.volces.com/api/plan",
    "defaultContextWindow": 1048576,
    "defaultMaxTokens": 128000,
    "compat": {
      "allowEmptySignature": true,
      "forceAdaptiveThinking": true
    },
    "models": [
      {
        "id": "ark-code-latest",
        "name": "Ark Code Latest（账号路由）",
        "defaultReasoning": null,
        "messagesThinkingMode": "server-default",
        "canDisableThinking": null,
        "capabilityStatus": "dynamic",
        "capabilityNote": "账号选择路由，能力随目标模型变化；容量为保守配置。",
        "maxTokens": 32000,
        "input": [
          "text"
        ],
        "reasoningEfforts": false,
        "compat": {
          "forceAdaptiveThinking": false
        },
        "aliases": [],
        "contextWindow": 256000,
        "capabilityUnverified": true
      },
      {
        "id": "doubao-seed-evolving",
        "name": "豆包 Seed Evolving",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "aliases": [
          "doubao-seed-evolving-latest-version"
        ]
      },
      {
        "id": "doubao-seed-2-1-pro-260915",
        "name": "豆包 Seed 2.1 Pro",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "aliases": [
          "doubao-seed-2-1-pro",
          "doubao-seed-2.1-pro"
        ]
      },
      {
        "id": "doubao-seed-2-1-lite-260915",
        "name": "豆包 Seed 2.1 Lite",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "aliases": [
          "doubao-seed-2-1-lite",
          "doubao-seed-2.1-lite"
        ]
      },
      {
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "doubao-seed-2-0-mini-260428",
        "name": "豆包 Seed 2.0 Mini",
        "defaultReasoning": "medium",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "aliases": [
          "doubao-seed-2-0-mini",
          "doubao-seed-2.0-mini"
        ],
        "contextWindow": 262144,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "kimi-k3-1-pro-261024",
        "name": "Kimi K3.1 Pro",
        "defaultReasoning": "max",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "documented",
        "aliases": [
          "kimi-k3.1-pro",
          "kimi-k3-1-pro-261001"
        ],
        "contextWindow": 1048576,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek-v4-1-flash-261017",
        "name": "DeepSeek V4.1 Flash",
        "defaultReasoning": "high",
        "messagesThinkingMode": "adaptive",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "deepseek-v4-1-flash",
          "deepseek-v4.1-flash"
        ]
      },
      {
        "id": "deepseek-v4-1-flash-economy-261017",
        "name": "DeepSeek V4.1 Flash Economy",
        "defaultReasoning": "high",
        "messagesThinkingMode": "adaptive",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1049000,
        "maxTokens": 393216,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "deepseek-v4-1-flash-economy",
          "deepseek-v4.1-flash-economy"
        ]
      },
      {
        "id": "kimi-k2-8-preview",
        "name": "Kimi K2.8 Preview",
        "defaultReasoning": null,
        "messagesThinkingMode": "enabled",
        "canDisableThinking": null,
        "capabilityStatus": "partial",
        "capabilityNote": "已确认三档思考；套餐默认档位与关闭控制未单独声明。",
        "contextWindow": 1048576,
        "maxTokens": 1048576,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "kimi-k2.8-preview",
          "kimi-k2-8-260901"
        ]
      },
      {
        "id": "glm-5-3-flash-260828",
        "name": "GLM 5.3 Flash",
        "defaultReasoning": "max",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "glm-5-3-flash",
          "glm-5.3-flash",
          "glm-5-3-flash-260901"
        ]
      },
      {
        "id": "glm-5.3",
        "name": "GLM 5.3",
        "defaultReasoning": null,
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "partial",
        "capabilityNote": "三档与常驻思考已确认；原厂默认 max，火山套餐未单列默认档位。",
        "maxTokens": 128000,
        "input": [
          "text"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "glm-5-3-260801",
          "glm-latest"
        ],
        "contextWindow": 1048576
      },
      {
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "deepseek-v4-pro-ga-260813",
        "name": "DeepSeek V4 Pro",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "aliases": [
          "deepseek-v4-pro",
          "deepseek-v4-pro-ga-260801"
        ],
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text"
        ]
      },
      {
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "deepseek-v4-flash-ga-260731",
        "name": "DeepSeek V4 Flash",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "aliases": [
          "deepseek-v4-flash",
          "deepseek-v4-flash-260801"
        ],
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text"
        ]
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "defaultReasoning": null,
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "partial",
        "capabilityNote": "三档与不可关闭已确认；套餐默认思考档位未单独声明。",
        "contextWindow": 1048576,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "kimi-k3-260701"
        ]
      },
      {
        "reasoningEfforts": false,
        "compat": {
          "forceAdaptiveThinking": false
        },
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "defaultReasoning": null,
        "messagesThinkingMode": "server-default",
        "canDisableThinking": null,
        "capabilityStatus": "partial",
        "capabilityNote": "该套餐的思考能力与控制尚未单独确认；保持服务端默认。",
        "aliases": [
          "kimi-k2-7-code-260601"
        ],
        "contextWindow": 262144,
        "maxTokens": 32768,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "reasoningEfforts": {
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "minimax-m3",
        "name": "MiniMax M3",
        "defaultReasoning": "medium",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": null,
        "capabilityStatus": "partial",
        "capabilityNote": "三档与默认 medium 已确认；完全关闭控制、Agent 套餐视觉未单独确认。",
        "aliases": [
          "minimax-m3-modelhub"
        ],
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  "coding-plan": {
    "api": "anthropic-messages",
    "baseURL": "https://ark.cn-beijing.volces.com/api/coding",
    "defaultContextWindow": 1048576,
    "defaultMaxTokens": 128000,
    "compat": {
      "allowEmptySignature": true,
      "forceAdaptiveThinking": true
    },
    "models": [
      {
        "id": "ark-code-latest",
        "name": "Ark Code Latest（账号路由）",
        "defaultReasoning": null,
        "messagesThinkingMode": "server-default",
        "canDisableThinking": null,
        "capabilityStatus": "dynamic",
        "capabilityNote": "账号选择路由，能力随目标模型变化；容量为保守配置。",
        "maxTokens": 32000,
        "input": [
          "text"
        ],
        "reasoningEfforts": false,
        "compat": {
          "forceAdaptiveThinking": false
        },
        "aliases": [],
        "contextWindow": 256000,
        "capabilityUnverified": true
      },
      {
        "id": "doubao-seed-evolving",
        "name": "豆包 Seed Evolving",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "aliases": [
          "doubao-seed-evolving-latest-version"
        ]
      },
      {
        "id": "doubao-seed-2-1-pro",
        "name": "豆包 Seed 2.1 Pro",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "aliases": [
          "doubao-seed-2-1-pro-260915",
          "doubao-seed-2.1-pro"
        ]
      },
      {
        "id": "doubao-seed-2-1-lite",
        "name": "豆包 Seed 2.1 Lite",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "aliases": [
          "doubao-seed-2-1-lite-260915",
          "doubao-seed-2.1-lite"
        ]
      },
      {
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "doubao-seed-2-0-mini",
        "name": "豆包 Seed 2.0 Mini",
        "defaultReasoning": "medium",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "aliases": [
          "doubao-seed-2-0-mini-260428",
          "doubao-seed-2.0-mini"
        ],
        "contextWindow": 262144,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "kimi-k3.1-pro",
        "name": "Kimi K3.1 Pro",
        "defaultReasoning": "max",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "documented",
        "aliases": [
          "kimi-k3-1-pro-261024",
          "kimi-k3-1-pro-261001"
        ],
        "contextWindow": 1048576,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek-v4-1-flash",
        "name": "DeepSeek V4.1 Flash",
        "defaultReasoning": "high",
        "messagesThinkingMode": "adaptive",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "deepseek-v4-1-flash-261017",
          "deepseek-v4.1-flash"
        ]
      },
      {
        "id": "deepseek-v4-1-flash-economy",
        "name": "DeepSeek V4.1 Flash Economy",
        "defaultReasoning": "high",
        "messagesThinkingMode": "adaptive",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "contextWindow": 1049000,
        "maxTokens": 393216,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "deepseek-v4-1-flash-economy-261017",
          "deepseek-v4.1-flash-economy"
        ]
      },
      {
        "id": "kimi-k2-8-preview",
        "name": "Kimi K2.8 Preview",
        "defaultReasoning": null,
        "messagesThinkingMode": "enabled",
        "canDisableThinking": null,
        "capabilityStatus": "partial",
        "capabilityNote": "已确认三档思考；套餐默认档位与关闭控制未单独声明。",
        "contextWindow": 1048576,
        "maxTokens": 1048576,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "kimi-k2.8-preview",
          "kimi-k2-8-260901"
        ]
      },
      {
        "id": "glm-5-3-flash",
        "name": "GLM 5.3 Flash",
        "defaultReasoning": "max",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "documented",
        "contextWindow": 1048576,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "glm-5-3-flash-260828",
          "glm-5.3-flash",
          "glm-5-3-flash-260901"
        ]
      },
      {
        "id": "glm-5.3",
        "name": "GLM 5.3",
        "defaultReasoning": null,
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "partial",
        "capabilityNote": "三档与常驻思考已确认；原厂默认 max，火山套餐未单列默认档位。",
        "maxTokens": 128000,
        "input": [
          "text"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "glm-5-3-260801",
          "glm-latest"
        ],
        "contextWindow": 1048576
      },
      {
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "aliases": [
          "deepseek-v4-pro-ga-260813",
          "deepseek-v4-pro-ga-260801"
        ],
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text"
        ]
      },
      {
        "reasoningEfforts": {
          "off": null,
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "defaultReasoning": "high",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": true,
        "capabilityStatus": "documented",
        "aliases": [
          "deepseek-v4-flash-ga-260731",
          "deepseek-v4-flash-260801"
        ],
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text"
        ]
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "defaultReasoning": null,
        "messagesThinkingMode": "enabled",
        "canDisableThinking": false,
        "capabilityStatus": "partial",
        "capabilityNote": "三档与不可关闭已确认；套餐默认思考档位未单独声明。",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ],
        "reasoningEfforts": {
          "low": "low",
          "high": "high",
          "max": "max"
        },
        "aliases": [
          "kimi-k3-260701"
        ]
      },
      {
        "reasoningEfforts": false,
        "compat": {
          "forceAdaptiveThinking": false
        },
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "defaultReasoning": null,
        "messagesThinkingMode": "server-default",
        "canDisableThinking": null,
        "capabilityStatus": "partial",
        "capabilityNote": "思考能力已确认，未列可调档位、默认档位与关闭控制。",
        "aliases": [
          "kimi-k2-7-code-260601"
        ],
        "contextWindow": 262144,
        "maxTokens": 32768,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "reasoningEfforts": {
          "low": "low",
          "medium": "medium",
          "high": "high"
        },
        "compat": {
          "forceAdaptiveThinking": true
        },
        "id": "minimax-m3",
        "name": "MiniMax M3",
        "defaultReasoning": "medium",
        "messagesThinkingMode": "enabled",
        "canDisableThinking": null,
        "capabilityStatus": "partial",
        "capabilityNote": "三档与默认 medium 已确认；完全关闭控制未单独确认。",
        "aliases": [
          "minimax-m3-modelhub"
        ],
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  }
} as const;
