import type {
  Configuration as ConfigurationT,
  OpenAIApi as OpenAIApiT,
  CreateCompletionRequest,
  CreateCompletionResponseChoicesInner,
} from "openai";

import { backOff } from "exponential-backoff";
import { chunkArray } from "../util";
import { BaseLLM, LLMResult, LLMCallbackManager } from ".";

let Configuration: typeof ConfigurationT | null = null;
let OpenAIApi: typeof OpenAIApiT | null = null;

try {
  // eslint-disable-next-line global-require,import/no-extraneous-dependencies
  ({ Configuration, OpenAIApi } = require("openai"));
} catch {
  // ignore error
}

interface ModelParams {
  /** Sampling temperature to use */
  temperature: number;

  /**
   * Maximum number of tokens to generate in the completion. -1 returns as many
   * tokens as possible given the prompt and the model's maximum context size.
   */
  maxTokens: number;

  /** Total probability mass of tokens to consider at each step */
  topP: number;

  /** Penalizes repeated tokens according to frequency */
  frequencyPenalty: number;

  /** Penalizes repeated tokens */
  presencePenalty: number;

  /** Number of completions to generate for each prompt */
  n: number;

  /** Generates `bestOf` completions server side and returns the "best" */
  bestOf: number;

  /** Dictionary used to adjust the probability of specific tokens being generated */
  logitBias?: Record<string, number>;
}

/**
 * Input to OpenAI class.
 * @augments ModelParams
 */
interface OpenAIInput extends ModelParams {
  /** Model name to use */
  modelName: string;

  /** Holds any additional parameters that are valid to pass to {@link
   * https://platform.openai.com/docs/api-reference/completions/create |
   * `openai.createCompletion`} that are not explicitly specified on this class.
   */
  modelKwargs?: Kwargs;

  /** Batch size to use when passing multiple documents to generate */
  batchSize: number;

  /** Maximum number of retries to make when generating */
  maxRetries: number;

  /** List of stop words to use when generating */
  stop?: string[];
}

type TokenUsage = {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Kwargs = Record<string, any>;

/**
 * Wrapper around OpenAI large language models.
 *
 * To use you should have the `openai` package installed, with the
 * `OPENAI_API_KEY` environment variable set.
 *
 * @remarks
 * Any parameters that are valid to be passed to {@link
 * https://platform.openai.com/docs/api-reference/completions/create |
 * `openai.createCompletion`} can be passed through {@link modelKwargs}, even
 * if not explicitly available on this class.
 *
 * @augments BaseLLM
 * @augments OpenAIInput
 */
export class OpenAI extends BaseLLM implements OpenAIInput {
  temperature = 0.7;

  maxTokens = 256;

  topP = 1;

  frequencyPenalty = 0;

  presencePenalty = 0;

  n = 1;

  bestOf = 1;

  logitBias?: Record<string, number>;

  modelName = "text-davinci-003";

  modelKwargs?: Kwargs;

  batchSize = 20;

  maxRetries = 6;

  stop?: string[];

  private client: OpenAIApiT;

  constructor(
    fields?: Partial<OpenAIInput> & {
      callbackManager?: LLMCallbackManager;
      verbose?: boolean;
      openAIApiKey?: string;
    }
  ) {
    super(fields?.callbackManager, fields?.verbose);
    if (Configuration === null || OpenAIApi === null) {
      throw new Error(
        "Please install openai as a dependency with, e.g. `npm i openai`"
      );
    }

    this.modelName = fields?.modelName ?? this.modelName;
    this.modelKwargs = fields?.modelKwargs ?? {};
    this.batchSize = fields?.batchSize ?? this.batchSize;
    this.maxRetries = fields?.maxRetries ?? this.maxRetries;

    this.temperature = fields?.temperature ?? this.temperature;
    this.maxTokens = fields?.maxTokens ?? this.maxTokens;
    this.topP = fields?.topP ?? this.topP;
    this.frequencyPenalty = fields?.frequencyPenalty ?? this.frequencyPenalty;
    this.presencePenalty = fields?.presencePenalty ?? this.presencePenalty;
    this.n = fields?.n ?? this.n;
    this.bestOf = fields?.bestOf ?? this.bestOf;
    this.logitBias = fields?.logitBias;
    this.stop = fields?.stop;

    const clientConfig = new Configuration({
      apiKey: fields?.openAIApiKey ?? process.env.OPENAI_API_KEY,
    });
    this.client = new OpenAIApi(clientConfig);
  }

  /**
   * Get the parameters used to invoke the model
   */
  invocationParams(): CreateCompletionRequest & Kwargs {
    return {
      model: this.modelName,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      top_p: this.topP,
      frequency_penalty: this.frequencyPenalty,
      presence_penalty: this.presencePenalty,
      n: this.n,
      best_of: this.bestOf,
      logit_bias: this.logitBias,
      stop: this.stop,
      ...this.modelKwargs,
    };
  }

  /**
   * Get the identifyin parameters for the model
   */
  identifyingParams() {
    return {
      model_name: this.modelName,
      ...this.invocationParams(),
    };
  }

  /**
   * Call out to OpenAI's endpoint with k unique prompts
   *
   * @param prompts - The prompts to pass into the model.
   * @param [stop] - Optional list of stop words to use when generating.
   *
   * @returns The full LLM output.
   *
   * @example
   * ```ts
   * import { OpenAI } from "langchain/llms";
   * const openai = new OpenAI();
   * const response = await openai.generate(["Tell me a joke."]);
   * ```
   */
  async _generate(prompts: string[], stop?: string[]): Promise<LLMResult> {
    const subPrompts = chunkArray(prompts, this.batchSize);
    const choices: CreateCompletionResponseChoicesInner[] = [];
    const tokenUsage: TokenUsage = {};

    if (this.stop && stop) {
      throw new Error("Stop found in input and default params");
    }

    const params = this.invocationParams();
    params.stop = stop ?? params.stop;

    for (let i = 0; i < subPrompts.length; i += 1) {
      const { data } = await this.completionWithRetry({
        ...params,
        prompt: subPrompts[i],
      });
      choices.push(...data.choices);
      const {
        completion_tokens: completionTokens,
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
      } = data.usage ?? {};

      if (completionTokens) {
        tokenUsage.completionTokens =
          (tokenUsage.completionTokens ?? 0) + completionTokens;
      }

      if (promptTokens) {
        tokenUsage.promptTokens = (tokenUsage.promptTokens ?? 0) + promptTokens;
      }

      if (totalTokens) {
        tokenUsage.totalTokens = (tokenUsage.totalTokens ?? 0) + totalTokens;
      }
    }

    const generations = chunkArray(choices, this.n).map((promptChoices) =>
      promptChoices.map((choice) => ({
        text: choice.text ?? "",
        generationInfo: {
          finishReason: choice.finish_reason,
          logprobs: choice.logprobs,
        },
      }))
    );
    return {
      generations,
      llmOutput: { tokenUsage },
    };
  }

  /** @ignore */
  completionWithRetry(request: CreateCompletionRequest) {
    const makeCompletionRequest = () => this.client.createCompletion(request);
    return backOff(makeCompletionRequest, {
      startingDelay: 4,
      maxDelay: 10,
      numOfAttempts: this.maxRetries,
      // TODO(sean) pass custom retry function to check error types.
    });
  }

  _llmType() {
    return "openai";
  }
}
