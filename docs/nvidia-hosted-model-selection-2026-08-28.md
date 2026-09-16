# NVIDIA hosted model selection for note generation

Date checked: 2026-08-28

## Decision

Which model should this plugin use by default? Use `nvidia/nemotron-3-super-120b-a12b`.

Why? It gives the best balance of note quality, long-context work, structured output, speed, and present hosted-service evidence. NVIDIA describes Super as suitable for complex instruction following, long-context reasoning, retrieval-augmented generation (RAG), and high-volume workloads. RAG means that the model answers with supplied source material. NVIDIA also trained Super on structured outputs, long-range retrieval, and multi-document aggregation. These properties match the plugin's atomic note blocks, folder routing, vault-context use, and diagram plans. [NVIDIA Nemotron 3 Super model card](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard)

Use `nvidia/nemotron-3-ultra-550b-a55b` only as an optional quality mode. Ultra has the best official instruction-following and long-context results, but it uses more computation. Use it for difficult source material, not for each normal note.

Do not use `nvidia/nemotron-3.5-lightning-30b-a3b` as the default until its hosted endpoint is stable in the user's account. NVIDIA marks the endpoint as available. However, an availability label does not give a service-level guarantee. NVIDIA states that its free catalog can have long waits during high load. [Lightning endpoint page](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b) and [NVIDIA NIM FAQ](https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317)

## Terms

- **Context length**: The maximum token window that a model can process. A token is a small text unit. A large window lets the model inspect a long conversation. It does not mean that the plugin must create one large note.
- **Mixture of Experts (MoE)**: A model design that uses only some model sections for each token.
- **Active parameters**: The model parameters used for one token. A lower value usually needs less computation. It does not prove hosted endpoint speed.
- **Rate limit**: The maximum request rate allowed for one account or model.

## Model comparison

| Model | Official context | Active parameters | Instruction result | Long-context result | Hosted status | Fit for this plugin |
|---|---:|---:|---:|---:|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 1M | 55B | IFBench 82.3 | AA-LCR 65.5; RULER 1M 94.0 | Free, partner, and download endpoints available | Best quality. Highest expected compute cost and latency. |
| `nvidia/nemotron-3-super-120b-a12b` | 1M | 12B | IFBench 72.56 | AA-LCR 58.31; RULER 1M 91.75 | Free, partner, and download endpoints available | Best default balance. NVIDIA targets high-volume work. |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 1M | 3B | IFBench 72.88 | AA-LCR 49.19 | Free, partner, and download endpoints marked available | Best speed design. New hosted endpoint needs stability checks. |
| `nvidia/nemotron-3-nano-30b-a3b` | Up to 1M in the card; catalog display can be lower | About 3.5B | IFBench 71.5 | AA-LCR 35.9; RULER 1M 86.3 | Direct deploy result says the free endpoint is deprecated | Lowest-priority text choice. It gives less long-context quality than Super. |

Sources: [Ultra model card](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard), [Ultra endpoint page](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b), [Super model card](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard), [Super endpoint page](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b), [Lightning model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard), [Lightning endpoint page](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b), [Nano model card](https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b/modelcard), and [Nano deploy page](https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b/deploy).

The benchmark names are not fully equal across every model card. For example, Lightning reports an IFBench "loose" result. Use the values as quality signals, not as a strict head-to-head test. No cited NVIDIA source gives a note-generation benchmark.

## Note quality

Which model gives the highest expected note quality? Ultra.

Ultra has the best official instruction-following and long-context scores in this group. NVIDIA designed it for complex multi-step work, long-context analysis, and high-accuracy reasoning. It was also trained on structured outputs, long-range retrieval, and multi-document aggregation. This is the strongest fit for difficult decomposition and synthesis. [NVIDIA Nemotron 3 Ultra model card](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard)

Which model gives the best practical note quality? Super.

Super has lower scores than Ultra, but its long-context results remain strong. It is also explicitly designed for high-volume workloads. Its 12B active parameters are much lower than Ultra's 55B active parameters. This supports the inference that Super is the better routine model when the endpoint must return many note operations. NVIDIA does not publish comparable hosted latency measurements for these four endpoints. [NVIDIA Nemotron 3 Super model card](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard)

## Structured output

The plugin needs exact blocks such as `=== ATOMIC NOTE ===`, Markdown, YAML, and placement actions. Super, Ultra, Lightning, and Nano were all trained on instruction following and structured output data. Super and Ultra also name long-range retrieval and multi-document aggregation in their training descriptions. This makes Super and Ultra the safest choices for the current prompt format. [Super model card](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard), [Ultra model card](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard), [Lightning model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard), and [Nano model card](https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b/modelcard).

This plugin uses generated text blocks. It does not use an API-enforced JSON schema. Model training reduces format errors, but it cannot prevent all errors. The plugin must keep its parser validation and safe failure behavior. See [the project prompts](../src/prompts.ts).

## Speed and endpoint capacity

Which model has the fastest design? Lightning.

Lightning has 3B active parameters. NVIDIA calls it its fastest 30B A3B model and provides speculative decoding methods for faster generation. Speculative decoding predicts several future tokens to improve generation speed. [Lightning model card](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard)

Which model has the strongest present usage evidence? Super.

The Super endpoint page reports 65 million API calls in the previous 30 days. The Ultra page reports 52 million. This is catalog-wide activity. It is not a user quota and it does not prove lower latency. It does show that both hosted routes receive large use. [Super endpoint page](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b) and [Ultra endpoint page](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b).

Lightning is new. Its page does not yet give an equivalent 30-day call count. Therefore, there is less public operating history for the free route.

## Free-tier limits

Does NVIDIA document a model with the highest free usage limit? No.

NVIDIA does not publish a fixed, model-by-model free quota. Its FAQ says that request rates vary by model and by the number of concurrent users. It tells each user to inspect the account menu on `build.nvidia.com`. NVIDIA also states that the free catalog is for evaluation and prototyping. It can have extended waits during high load. [NVIDIA NIM FAQ](https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317)

NVIDIA removed the former credit system. An NVIDIA representative states that request rates vary by model and current concurrent use. [NVIDIA forum answer about API credits and limits](https://forums.developer.nvidia.com/t/cannot-find-the-amount-of-credits-left-on-nim-api/337051)

NVIDIA also states that there is no official way to increase the free-tier rate limit through a forum request. Stable or unlimited work needs a self-hosted NIM, an NVIDIA AI Enterprise option, or a paid partner endpoint. [NVIDIA rate-limit policy](https://forums.developer.nvidia.com/t/api-rate-limit-increase-is-not-granted-by-requesting-it-here/368420)

Therefore, do not claim that Super, Ultra, Lightning, or Nano has a higher free usage limit. The public data cannot support that claim. Check the signed-in account limit for each model before a final selection.

## Other NVIDIA models

- `nvidia/nemotron-3-embed-1b` is an embedding model. An embedding is a numeric text representation for search. It can support future semantic vault search, but it cannot replace the note-generation model. [NVIDIA model catalog](https://build.nvidia.com/models)
- Vision models can read images. The plugin already has a separate vision-model setting. Do not select a vision model as the default text-note model only because the workflow accepts screenshots.
- Older Nano and Llama Nemotron models do not give a better balance than Super for this text workflow. Nano has lower cited long-context results. The catalog can also remove or deprecate hosted routes.

## Recommended operating policy

1. Set `nvidia/nemotron-3-super-120b-a12b` as the default text model.
2. Keep reasoning off for simple reformatting and small note edits. Turn it on for atomic decomposition, vault routing, and difficult synthesis. Super supports this switch through `enable_thinking`.
3. Offer `nvidia/nemotron-3-ultra-550b-a55b` as a manual quality mode.
4. Do not silently change models after an error. Show the exact failed model and let the user choose another model.
5. Keep the current atomic-note design. A 1M-token context is input capacity. It is not a reason to save one full conversation as one note.
6. Recheck the signed-in model limit and endpoint status before a release. Public free-tier limits can change.

## Final recommendation

Use Super now:

`nvidia/nemotron-3-super-120b-a12b`

It is the best default for this plugin. It has strong long-context results, structured-output training, a 1M context window, high-volume positioning, and a currently listed free endpoint. Use Ultra only when the user asks for maximum quality. Revisit Lightning after repeated live tests show stable responses.
