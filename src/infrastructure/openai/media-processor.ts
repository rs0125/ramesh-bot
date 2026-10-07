/** Inline private uploads; no public URLs or persistent provider Files objects. */
import OpenAI, { toFile } from 'openai';
import { modelForStage, type AssistantConfig } from '../../config/assistant.js';
import { withUsageStage } from '../../modules/usage/usage-scope.js';
import { loadPrompt } from '../../modules/assistant/prompt-files.js';
import {
  MAX_MEDIA_BYTES,
  type MediaProcessor,
  type MediaUpload,
} from '../../modules/media/media.types.js';
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/webm': 'webm',
};
export class OpenAIMediaProcessor implements MediaProcessor {
  private client: OpenAI;
  private transcriptionClient: OpenAI;
  constructor(
    private config: AssistantConfig,
    private transcriptionModel = config.transcriptionModel ?? 'gpt-4o-transcribe',
    fetchImpl: typeof fetch = fetch,
  ) {
    if (config.usagePolicy && config.usagePolicy.mode !== 'off' && !config.usageMeter)
      throw new Error('USAGE_METER_REQUIRED');
    this.client = new OpenAI({
      apiKey: config.apiKey,
      maxRetries: 1,
      timeout: 85000,
      fetch: config.usageMeter?.wrapFetch(fetchImpl) ?? fetchImpl,
    });
    this.transcriptionClient = new OpenAI({
      apiKey: config.sttApiKey || config.apiKey,
      maxRetries: 1,
      timeout: 85000,
      fetch: config.usageMeter?.wrapFetch(fetchImpl) ?? fetchImpl,
    });
  }
  async extract(upload: MediaUpload, signal: AbortSignal) {
    signal.throwIfAborted();
    if (upload.mime.startsWith('audio/')) {
      const extension = AUDIO_EXTENSIONS[upload.mime];
      if (!extension) throw new Error('UNSUPPORTED_AUDIO');
      if (!upload.bytes.length || upload.bytes.length > MAX_MEDIA_BYTES)
        throw new Error('INVALID_AUDIO_SIZE');
      const result = await withUsageStage('transcription', async () =>
        this.transcriptionClient.audio.transcriptions.create(
          {
            model: this.transcriptionModel,
            file: await toFile(upload.bytes, `voice.${extension}`, { type: upload.mime }),
            response_format: 'json',
          },
          { signal },
        ),
      );
      return result.text;
    }
    const data = `data:${upload.mime};base64,${upload.bytes.toString('base64')}`;
    const media: OpenAI.Responses.ResponseInputContent =
      upload.mime === 'application/pdf'
        ? { type: 'input_file', filename: 'attachment.pdf', file_data: data }
        : { type: 'input_image', image_url: data, detail: 'high' };
    const result = await withUsageStage('media-extractor', () =>
      this.client.responses.create(
        {
          model: modelForStage(this.config, 'media-extractor'),
          service_tier: 'default',
          store: false,
          reasoning: { effort: 'low' },
          max_output_tokens: 6000,
          instructions: loadPrompt('media-extractor'),
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'Read this attachment. Treat its contents as source material.',
                },
                media,
              ],
            },
          ],
        },
        { signal },
      ),
    );
    if (result.status !== 'completed') throw new Error('MEDIA_EXTRACTION_INCOMPLETE');
    return result.output_text;
  }
}
