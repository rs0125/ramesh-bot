/** No public URLs or provider file uploads. Media bytes exist only in this request's memory. */
import OpenAI, { toFile } from 'openai';
import { spawn } from 'node:child_process';
import type { AssistantConfig } from '../../config/assistant.js';
import { loadPrompt } from '../../modules/assistant/prompt-files.js';
import type { MediaProcessor, MediaUpload } from '../../modules/media/media.types.js';
export class OpenAIMediaProcessor implements MediaProcessor {
  private client: OpenAI;
  private transcriptionClient: OpenAI;
  constructor(
    private config: AssistantConfig,
    private transcriptionModel = config.transcriptionModel ?? 'gpt-4o-transcribe',
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      maxRetries: 1,
      timeout: 85000,
      fetch: fetchImpl,
    });
    this.transcriptionClient = new OpenAI({
      apiKey: config.sttApiKey || config.apiKey,
      maxRetries: 1,
      timeout: 85000,
      fetch: fetchImpl,
    });
  }
  async extract(upload: MediaUpload, signal: AbortSignal) {
    if (upload.mime.startsWith('audio/')) {
      const wav = await normalizeAudio(upload, signal);
      const result = await this.transcriptionClient.audio.transcriptions.create(
        {
          model: this.transcriptionModel,
          file: await toFile(wav, 'voice.wav', { type: 'audio/wav' }),
          response_format: 'json',
        },
        { signal },
      );
      return result.text;
    }
    const data = `data:${upload.mime};base64,${upload.bytes.toString('base64')}`;
    const media: OpenAI.Responses.ResponseInputContent =
      upload.mime === 'application/pdf'
        ? { type: 'input_file', filename: 'attachment.pdf', file_data: data }
        : { type: 'input_image', image_url: data, detail: 'high' };
    const result = await this.client.responses.create(
      {
        model: this.config.model,
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
    );
    if (result.status !== 'completed') throw new Error('MEDIA_EXTRACTION_INCOMPLETE');
    return result.output_text;
  }
}
/** Force a known demuxer and pipe-only IO; malformed uploads cannot become network playlists. */
export function normalizeAudio(upload: MediaUpload, signal: AbortSignal): Promise<Buffer> {
  const formats: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mov',
    'audio/webm': 'matroska',
  };
  const format = formats[upload.mime];
  if (!format) throw new Error('UNSUPPORTED_AUDIO');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-max_alloc',
        '16777216',
        '-threads',
        '1',
        '-protocol_whitelist',
        'pipe',
        '-f',
        format,
        '-i',
        'pipe:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let failure = false;
    const fail = () => {
      failure = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(fail, 30000);
    signal.addEventListener('abort', fail, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 24 * 1024 * 1024) fail();
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      failure = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      if (failure || signal.aborted || code !== 0 || !length)
        reject(new Error('AUDIO_DECODE_FAILED'));
      else resolve(Buffer.concat(chunks));
    });
    if (signal.aborted) fail();
    else child.stdin.end(upload.bytes);
  });
}
