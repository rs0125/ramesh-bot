/** Runs the graph within a deadline; keeps conversation context out of transport and prompts out of logs. */
import { createHash, randomUUID } from 'node:crypto';
import type { AssistantConfig } from '../../config/assistant.js';
import type {
  GreetingCandidate,
  PreparedReply,
  TrustedReplyContext,
} from '../greetings/greeting.types.js';
import type { AgentTrace, ChatMessage, TextModel } from './assistant.types.js';
import { buildAssistantGraph } from './assistant.graph.js';
import { ConversationMemory, PRIVATE_HISTORY_REPLY } from './conversation-memory.js';
import { PROMPT_VERSION } from './prompts.js';
import { buildBusinessGraph, READ_PROMPT_VERSION } from './business.graph.js';
import type { BusinessReadService } from './business-reads.js';
import { buildSalesGraph, type GraphContextObservation } from './sales.graph.js';
import { SALES_PROMPT_VERSION } from './sales-prompts.js';
import { getBusinessReply, writeDeliveryBundle } from '../messaging/delivery-evidence.js';
import { bindUsageEmployee, currentUsageScope, withUsageScope } from '../usage/usage-scope.js';
import type { UsageMeter } from '../usage/usage-meter.js';
import { UtilityToolRun } from './utility-tools.js';
import { CheckpointError, type AgentCheckpointStore } from './checkpoint.types.js';
import { withModelReplay, replayedModelSteps } from './model-replay.js';
import type { PersonalToolRun, PersonalToolService } from '../scheduling/personal-tools.js';
import type {
  BusinessWriteReply,
  BusinessWriteRun,
  BusinessWriteService,
} from '../writes/write-tools.js';

export interface AssistantReply extends PreparedReply {
  trace: AgentTrace;
  draft?: string;
}
export const UNAVAILABLE_REPLY = "I'm having trouble replying right now. Try again in a bit.";

export class AssistantService {
  private readonly graph;
  constructor(
    private readonly modelConfig: Pick<
      AssistantConfig,
      'model' | 'timeoutMs' | 'usageMeter' | 'tavilyApiKey'
    >,
    private readonly model: TextModel,
    private readonly memory = new ConversationMemory(),
    private readonly observe: (trace: AgentTrace) => void = () => {},
    private readonly readHistory?: (message: GreetingCandidate) => Promise<ChatMessage[]>,
    private readonly businessReads?: BusinessReadService,
    private readonly runtime: {
      now?: () => number;
      observeContext?: (context: GraphContextObservation) => void;
      usageMeter?: UsageMeter;
      utilityFetch?: typeof fetch;
      checkpoints?: AgentCheckpointStore;
      personalTools?: PersonalToolService;
      businessWrites?: BusinessWriteService;
    } = {},
  ) {
    this.graph = buildAssistantGraph(model);
  }

  private key(message: GreetingCandidate): string | undefined {
    return createHash('sha256').update(message.chatId).digest('hex');
  }

  /** Local development fallback; production reads the durable inbox instead. */
  observeMessage(message: GreetingCandidate) {
    if (this.readHistory || message.fromMe || !message.text) return;
    const key = this.key(message);
    if (key) this.memory.observe(key, this.input(message));
  }

  private input(message: GreetingCandidate): string {
    return message.isGroup
      ? JSON.stringify({
          sender: message.senderName ?? message.senderId ?? 'Unknown sender',
          senderId: message.senderId,
          text: message.text,
        })
      : (message.text?.trim() ?? '');
  }

  clear(message: GreetingCandidate) {
    const key = this.key(message);
    if (key) this.memory.clear(key);
  }

  async prepare(
    message: GreetingCandidate,
    signal?: AbortSignal,
    trusted?: TrustedReplyContext,
  ): Promise<AssistantReply> {
    const runId = trusted?.runId ?? randomUUID();
    const upstream = currentUsageScope()?.scope;
    return withUsageScope(
      {
        runId,
        // Only an application-owned enclosing scope for this same turn may carry billing identity.
        // It does not grant business access; the graph still performs live tool authorization.
        subjectId:
          (upstream?.runId === runId ? upstream.subjectId : undefined) ??
          `sender:${createHash('sha256')
            .update(message.senderId ?? message.chatId)
            .digest('hex')}`,
      },
      () => this.prepareScoped(message, signal, trusted, runId),
    );
  }

  private async prepareScoped(
    message: GreetingCandidate,
    signal: AbortSignal | undefined,
    trusted: TrustedReplyContext | undefined,
    runId: string,
  ): Promise<AssistantReply> {
    signal?.throwIfAborted();
    const onToolActivity =
      trusted?.key.remoteJid === message.chatId ? trusted.onToolActivity : undefined;
    const started = Date.now();
    const trace: AgentTrace = {
      runId,
      model: this.modelConfig.model,
      promptVersion:
        this.businessReads?.toolLoop || this.runtime.personalTools || this.runtime.businessWrites
          ? SALES_PROMPT_VERSION
          : this.businessReads
            ? READ_PROMPT_VERSION
            : PROMPT_VERSION,
      durationMs: 0,
      stages: [],
      outcome: 'completed',
    };
    const finish = async (reply: Omit<AssistantReply, 'trace'>): Promise<AssistantReply> => {
      trace.durationMs = Date.now() - started;
      const reused = replayedModelSteps();
      if (reused) trace.replayedSteps = reused;
      const meter = this.runtime.usageMeter ?? this.modelConfig.usageMeter;
      if (meter) {
        try {
          trace.usage = await meter.summarize(runId);
        } catch {
          trace.usageUnavailable = true;
        }
      }
      this.observe(trace);
      return { ...reply, trace };
    };
    const input = message.text?.trim() ?? '';
    if (!input || input.length > (message.batchMessageIds ? 32000 : 6000)) {
      trace.outcome = 'input_rejected';
      return finish({
        text: input
          ? 'That message is a bit long. Can you split it into smaller parts?'
          : 'Could you send that as text?',
      });
    }
    let personal: PersonalToolRun | undefined;
    let writes: BusinessWriteRun | undefined;
    let recoveredWrite: BusinessWriteReply | undefined;
    try {
      let writeSignal: AbortSignal | undefined;
      if (!message.isGroup && trusted?.key.remoteJid === message.chatId) {
        // Confirmation and receipt recovery are application commands, never model tool calls.
        const writeDeadline = AbortSignal.timeout(this.modelConfig.timeoutMs);
        writeSignal = signal ? AbortSignal.any([signal, writeDeadline]) : writeDeadline;
        recoveredWrite = await this.runtime.businessWrites?.recover(trusted, writeSignal);
      }
      // A committed mutation is authoritative even if the old model deadline or journal expired.
      // Receipt lookup still requires a current inbound lease and freshly resolved owner identity.
      const recoveryDeadline = AbortSignal.timeout(Math.min(5000, this.modelConfig.timeoutMs));
      const recoverySignal = signal
        ? AbortSignal.any([signal, recoveryDeadline])
        : recoveryDeadline;
      personal =
        !message.isGroup && trusted?.key.remoteJid === message.chatId
          ? await this.runtime.personalTools?.open(trusted, recoverySignal)
          : undefined;
      if (personal) bindUsageEmployee(personal.employeeId);
      const recovered = await personal?.recover(recoverySignal);
      // A mixed turn can commit a personal batch and publish a business proposal before
      // handoff crashes. Preserve both receipts so delivery retains both authorization fences.
      if (recoveredWrite)
        return finish({
          text: [recovered?.text, recoveredWrite.text].filter(Boolean).join('\n\n'),
          businessEvidence: writeDeliveryBundle(
            recoveredWrite.delivery,
            recovered?.delivery,
            recovered?.text,
          ),
        });
      if (recovered) return finish({ text: recovered.text, businessEvidence: recovered.delivery });
      const quickReply = await personal?.quickReply(recoverySignal);
      if (quickReply)
        return finish({ text: quickReply.text, businessEvidence: quickReply.delivery });
      if (writeSignal && trusted) {
        try {
          writes = await this.runtime.businessWrites?.open(trusted, writeSignal);
        } catch (error) {
          if (error instanceof CheckpointError) throw error;
          signal?.throwIfAborted();
          // Optional write discovery must not disable independent personal/read/chat work.
          // Exact confirmation commands were already handled by recover above.
        }
        if (writes) bindUsageEmployee(writes.employeeId);
      }
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      signal?.throwIfAborted();
      // A remote write may already have committed before unrelated personal recovery fails.
      // Keep its durable receipt; handoff still requires any committed personal receipt too.
      if (recoveredWrite)
        return finish({
          text: recoveredWrite.text,
          businessEvidence: writeDeliveryBundle(recoveredWrite.delivery),
        });
      trace.outcome = 'unavailable';
      trace.failureCode = 'RUN_FAILED';
      return finish({ text: UNAVAILABLE_REPLY });
    }
    const checkpoint =
      trusted?.checkpointLease && this.runtime.checkpoints
        ? await this.runtime.checkpoints.begin({
            jobId: runId,
            leaseToken: trusted.checkpointLease.leaseToken,
            binding: {
              version: 1,
              model: this.modelConfig.model,
              promptVersion: trace.promptVersion,
              key: trusted.key,
              chatId: message.chatId,
              senderId: message.senderId,
              input: this.input(message),
              media: trusted.mediaContext ?? '',
            },
            requestTimeMs: (this.runtime.now ?? Date.now)(),
            startedAtMs: started,
            deadlineAtMs: started + this.modelConfig.timeoutMs,
          })
        : undefined;
    return withModelReplay(checkpoint, async () => {
      const deadlineAtMs =
        checkpoint?.metadata.deadlineAtMs ?? started + this.modelConfig.timeoutMs;
      if (deadlineAtMs <= Date.now()) {
        trace.outcome = 'unavailable';
        trace.failureCode = 'DEADLINE_EXCEEDED';
        return finish({ text: UNAVAILABLE_REPLY });
      }
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(new DOMException('Assistant timed out', 'TimeoutError')),
        deadlineAtMs - Date.now(),
      );
      const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const key = this.key(message);
      try {
        const history = this.readHistory
          ? await this.readHistory(message)
          : key
            ? this.memory.get(key)
            : [];
        combined.throwIfAborted();
        const inputState = {
          input:
            this.input(message) +
            (trusted?.mediaContext ? `\nAttachment source data:\n${trusted.mediaContext}` : ''),
          history,
          audience: message.isGroup ? ('group' as const) : ('dm' as const),
        };
        const graphConfig = { signal: combined, recursionLimit: 6 };
        const result =
          this.businessReads?.toolLoop || personal || writes
            ? await buildSalesGraph(
                this.model,
                async (readSignal) => {
                  const tools = this.businessReads?.toolLoop
                    ? await this.businessReads.openTools(
                        trusted?.key.remoteJid === message.chatId ? trusted : undefined,
                        readSignal,
                      )
                    : { status: 'denied' as const };
                  if (tools.run) bindUsageEmployee(tools.run.employeeId);
                  return tools;
                },
                {
                  now: checkpoint ? () => checkpoint.metadata.requestTimeMs : this.runtime.now,
                  researchDeadlineMs:
                    deadlineAtMs - Math.min(60000, this.modelConfig.timeoutMs / 4),
                  onStage: (stage) => trace.stages.push(stage),
                  onContext: this.runtime.observeContext,
                  onToolActivity,
                  utilities: new UtilityToolRun(
                    this.modelConfig.tavilyApiKey,
                    this.runtime.utilityFetch,
                    this.runtime.now,
                  ),
                  personal,
                  writes,
                },
              ).invoke(inputState, { signal: combined, recursionLimit: 76 })
            : this.businessReads
              ? await buildBusinessGraph(
                  this.model,
                  (readSignal) =>
                    this.businessReads!.read(
                      trusted?.key.remoteJid === message.chatId ? trusted : undefined,
                      readSignal,
                    ),
                  onToolActivity,
                ).invoke(inputState, graphConfig)
              : await this.graph.invoke(inputState, graphConfig);
        combined.throwIfAborted();
        trace.stages = result.stages;
        if ('researchExhausted' in result && result.researchExhausted)
          trace.limitedBy = 'research_deadline';
        const business = 'business' in result ? result.business : undefined;
        const personalReply = 'personal' in result ? result.personal : undefined;
        const composite = 'composite' in result ? result.composite : undefined;
        const writeReply = 'write' in result ? result.write : undefined;
        const otherEvidence = personalReply
          ? (composite ?? personalReply.delivery)
          : business?.outcome === 'verified'
            ? business.delivery
            : undefined;
        const evidence = writeReply
          ? writeDeliveryBundle(
              writeReply.delivery,
              otherEvidence,
              'writeOtherText' in result ? result.writeOtherText : undefined,
            )
          : otherEvidence;
        if (business?.outcome === 'unavailable') trace.outcome = 'unavailable';
        if ('unavailable' in result && result.unavailable) trace.outcome = 'unavailable';
        let remembered = false;
        return finish({
          text: result.reply,
          draft: result.draft,
          ...(evidence ? { businessEvidence: evidence } : {}),
          onSent: () => {
            if (!remembered && key) {
              this.memory.remember(
                key,
                this.input(message),
                evidence ? PRIVATE_HISTORY_REPLY : result.reply,
                evidence ? getBusinessReply({ text: result.reply, receipt: evidence }) : undefined,
              );
              remembered = true;
            }
          },
        });
      } catch (error) {
        if (error instanceof CheckpointError) throw error;
        signal?.throwIfAborted();
        trace.outcome = 'unavailable';
        trace.failureCode = deadline.signal.aborted ? 'DEADLINE_EXCEEDED' : 'RUN_FAILED';
        return finish({ text: UNAVAILABLE_REPLY });
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
