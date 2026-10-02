/** The encrypted Supabase inbox is shared by the admin UI and the assistant's context reader. */
import type { Pool } from 'pg';
import type { ConversationPage, InboxMessage, InboxPage } from '../../contracts/admin-api.js';
import type { ChatMessage } from '../../modules/assistant/assistant.types.js';
import {
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_CHARACTERS,
  PRIVATE_HISTORY_REPLY,
} from '../../modules/assistant/conversation-memory.js';
import type { GreetingCandidate } from '../../modules/greetings/greeting.types.js';
import { GROUP_REPLIES_REQUIRE_MENTION } from '../../config/group-policy.js';
import { authCipher } from './auth-store.js';
import { decodeReply } from '../../modules/messaging/reply-payload.js';

export interface InboxContent {
  text: string;
  senderId: string | null;
  senderName: string;
  chatName: string | null;
  kind: string;
}
interface InboxRow {
  id: string;
  chat_id: string;
  origin: 'whatsapp' | 'admin';
  mentions_bot: boolean;
  content_encrypted: string;
  reply_encrypted: string | null;
  reply_kind?: 'conversation' | 'business';
  business_evidence_encrypted?: string | null;
  state: string;
  sent_at: Date;
  created_at: Date;
  updated_at: Date;
  created_cursor: string;
  updated_cursor: string;
  reply_created_at: Date | null;
  finished_at: Date | null;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function validChatId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    /^[\w.-]+@(g\.us|s\.whatsapp\.net|lid)$/.test(value)
  );
}
export function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
export function decodeInboxCursor(cursor?: string | null): [string, string] | null {
  if (!cursor) return null;
  if (cursor.length > 256 || !/^[\w-]+$/.test(cursor)) throw new Error('Invalid inbox cursor');
  const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !Number.isFinite(Date.parse(value[0])) ||
    !validRequestId(value[1])
  )
    throw new Error('Invalid inbox cursor');
  return value as [string, string];
}
function cursorFor(row: InboxRow, key: 'created_at' | 'updated_at'): string {
  // Preserve PostgreSQL microseconds; JavaScript Date truncation can skip rows at page boundaries.
  return Buffer.from(
    JSON.stringify([key === 'created_at' ? row.created_cursor : row.updated_cursor, row.id]),
  ).toString('base64url');
}

export class InboxRepository {
  private readonly cipher;
  constructor(
    private readonly pool: Pool,
    private readonly accountId: string,
    encryptionKey: string,
  ) {
    this.cipher = authCipher(encryptionKey);
  }

  private content(row: Pick<InboxRow, 'id' | 'content_encrypted'>): InboxContent {
    const data = this.cipher.open('inbox', row.id, row.content_encrypted) as InboxContent;
    if (!data || typeof data.text !== 'string' || typeof data.senderName !== 'string')
      throw new Error('Invalid inbox content');
    return data;
  }

  private messagesFor(row: InboxRow): InboxMessage[] {
    const content = this.content(row);
    const messages: InboxMessage[] =
      row.origin === 'admin'
        ? []
        : [
            {
              id: row.id,
              chatId: row.chat_id,
              text: content.text,
              senderId: content.senderId,
              senderName: content.senderName,
              direction: 'inbound',
              source: 'whatsapp',
              mentionsBot: row.mentions_bot,
              at: row.sent_at.toISOString(),
              status: 'RECEIVED',
              kind: content.kind,
            },
          ];
    if (row.reply_encrypted) {
      // The operational admin session grants no employee CRM authority.
      const text =
        row.reply_kind === 'business'
          ? '[Private CRM reply]'
          : decodeReply(
              this.cipher.open('outbound-reply', row.id, row.reply_encrypted),
              'conversation',
            ).text;
      if (typeof text !== 'string') throw new Error('Invalid inbox reply');
      messages.push({
        id: `${row.id}:reply`,
        chatId: row.chat_id,
        text,
        senderId: null,
        senderName: 'Ramesh',
        direction: 'outbound',
        source: row.origin === 'admin' ? 'admin' : 'assistant',
        mentionsBot: false,
        at: (
          (row.state === 'SENT' ? row.finished_at : null) ??
          row.reply_created_at ??
          row.created_at
        ).toISOString(),
        status: row.state,
        kind: 'text',
      });
    }
    return messages;
  }

  async conversations(cursor?: string | null): Promise<ConversationPage> {
    const before = decodeInboxCursor(cursor);
    const rows = (
      await this.pool.query<InboxRow & { name_id: string; name_content: string }>(
        `WITH latest AS (
        SELECT DISTINCT ON (chat_id) * FROM public."ramesh-messages"
        WHERE account_id=$1 AND content_encrypted IS NOT NULL
        ORDER BY chat_id,updated_at DESC,id DESC
      ) SELECT l.*,l.updated_at::text AS updated_cursor,n.id AS name_id,n.content_encrypted AS name_content FROM latest l
      JOIN LATERAL (
        SELECT id,content_encrypted FROM public."ramesh-messages"
        WHERE account_id=$1 AND chat_id=l.chat_id AND origin='whatsapp' AND content_encrypted IS NOT NULL
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) n ON true
      WHERE ($2::timestamptz IS NULL OR (l.updated_at,l.id)<($2::timestamptz,$3::uuid))
      ORDER BY l.updated_at DESC,l.id DESC LIMIT 51`,
        [this.accountId, before?.[0] ?? null, before?.[1] ?? null],
      )
    ).rows;
    return {
      conversations: rows.slice(0, 50).map((row) => {
        const content = this.content({ id: row.name_id, content_encrypted: row.name_content });
        const latest = this.messagesFor(row).at(-1)!;
        const isGroup = row.chat_id.endsWith('@g.us');
        return {
          chatId: row.chat_id,
          isGroup,
          name:
            content.chatName ||
            (isGroup ? `Group ${row.chat_id.split('@')[0]}` : content.senderName),
          lastMessage: latest.text.slice(0, 200),
          lastMessageAt: latest.at,
        };
      }),
      nextCursor: rows.length > 50 ? cursorFor(rows[49]!, 'updated_at') : null,
      groupRepliesRequireMention: GROUP_REPLIES_REQUIRE_MENTION,
    };
  }

  async messages(chatId: string, cursor?: string | null): Promise<InboxPage> {
    const before = decodeInboxCursor(cursor);
    const rows = (
      await this.pool.query<InboxRow>(
        `SELECT *,created_at::text AS created_cursor FROM public."ramesh-messages" WHERE account_id=$1 AND chat_id=$2 AND content_encrypted IS NOT NULL
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 26`,
        [this.accountId, chatId, before?.[0] ?? null, before?.[1] ?? null],
      )
    ).rows;
    return {
      messages: rows
        .slice(0, 25)
        .reverse()
        .flatMap((row) => this.messagesFor(row))
        .sort((a, b) => a.at.localeCompare(b.at)),
      nextCursor: rows.length > 25 ? cursorFor(rows[24]!, 'created_at') : null,
    };
  }

  /** Read messages preceding this trigger, across all group participants, never across chats/accounts. */
  async context(message: GreetingCandidate): Promise<ChatMessage[]> {
    const rows = (
      await this.pool.query<InboxRow>(
        `WITH anchor AS (
        SELECT created_at,id FROM public."ramesh-messages"
        WHERE account_id=$1 AND chat_id=$2 AND whatsapp_message_id=$3
      ) SELECT m.*,CASE WHEN m.state='SENT' AND m.finished_at<=a.created_at THEN m.reply_encrypted ELSE NULL END AS reply_encrypted
      FROM public."ramesh-messages" m,anchor a
      WHERE m.account_id=$1 AND m.chat_id=$2 AND m.content_encrypted IS NOT NULL
        AND (m.created_at,m.id)<(a.created_at,a.id)
      ORDER BY m.created_at DESC,m.id DESC LIMIT 40`,
        [this.accountId, message.chatId, message.messageId],
      )
    ).rows;
    // Supabase history is the source of truth; unsent output must never be presented as something said.
    const history = rows
      .reverse()
      .flatMap((row) =>
        this.messagesFor(row)
          .filter((item) => item.direction === 'inbound' || item.status === 'SENT')
          .map((item) =>
            row.reply_kind === 'business' && item.direction === 'outbound'
              ? {
                  ...item,
                  text: PRIVATE_HISTORY_REPLY,
                  ...(!message.isGroup && row.reply_encrypted && row.business_evidence_encrypted
                    ? {
                        protectedReply: {
                          text: decodeReply(
                            this.cipher.open('outbound-reply', row.id, row.reply_encrypted),
                            'business',
                          ).text,
                          receipt: this.cipher.open(
                            'business-delivery',
                            row.id,
                            row.business_evidence_encrypted,
                          ),
                        },
                      }
                    : {}),
                }
              : item,
          ),
      )
      .sort((a, b) => a.at.localeCompare(b.at));
    const result: ChatMessage[] = [];
    let size = 0;
    for (const item of history.reverse()) {
      const content =
        message.isGroup && item.direction === 'inbound'
          ? JSON.stringify({ sender: item.senderName, senderId: item.senderId, text: item.text })
          : item.text;
      const bounded = content.slice(0, 6000);
      if (size + bounded.length > MAX_HISTORY_CHARACTERS || result.length >= MAX_HISTORY_MESSAGES)
        break;
      result.unshift({
        role: item.direction === 'inbound' ? 'user' : 'assistant',
        content: bounded,
        ...('protectedReply' in item
          ? { protectedReply: item.protectedReply as ChatMessage['protectedReply'] }
          : {}),
      });
      size += bounded.length;
    }
    return result;
  }
}
