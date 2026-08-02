import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { CurrentUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

class LinkTelegramDto {
  /** Omit to have the server discover it from recent messages to the bot. */
  @IsOptional() @IsString() chatId?: string;
}

interface TelegramUpdate {
  message?: {
    chat: { id: number; type: string; username?: string; first_name?: string; title?: string };
    text?: string;
  };
}

/**
 * Telegram linking.
 *
 * The tedious part of Telegram integration is not sending — it is finding your
 * chat id, which Telegram does not show anywhere in its UI. So rather than
 * asking for a number the user has no way to look up, this endpoint reads the
 * bot's recent updates and takes the chat that just messaged it.
 *
 * The flow becomes: message the bot, press Connect. No ids, no third-party
 * "get my chat id" bots.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger('Telegram');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get token(): string {
    return this.config.get<string>('notifications.telegramBotToken') ?? '';
  }

  get configured(): boolean {
    return this.token.length > 0;
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    if (!this.configured) {
      throw new BadRequestException(
        'No TELEGRAM_BOT_TOKEN is set on the server. Create a bot with @BotFather, ' +
          'put the token in .env as TELEGRAM_BOT_TOKEN, and restart the API.',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: body ? 'POST' : 'GET',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
      if (!payload.ok) {
        throw new BadRequestException(`Telegram: ${payload.description ?? 'request failed'}`);
      }
      return payload.result as T;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `Could not reach Telegram: ${(error as Error).message}. Check the server's internet access.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bot identity, so the UI can tell the user who to message. */
  async status(userId: string) {
    const preferences = await this.prisma.userPreferences.findUnique({
      where: { userId },
      select: { telegramChatId: true },
    });

    if (!this.configured) {
      return {
        configured: false,
        linked: false,
        botUsername: null,
        chatId: null,
        note:
          'Telegram is not configured on the server. Add TELEGRAM_BOT_TOKEN to .env ' +
          'and restart the API.',
      };
    }

    let botUsername: string | null = null;
    try {
      const me = await this.call<{ username: string }>('getMe');
      botUsername = me.username;
    } catch {
      // A bad token should not make the settings page fail to load.
    }

    return {
      configured: true,
      linked: Boolean(preferences?.telegramChatId),
      botUsername,
      chatId: preferences?.telegramChatId ?? null,
      note: botUsername
        ? `Message @${botUsername} on Telegram, then press Connect.`
        : 'The configured bot token was rejected by Telegram.',
    };
  }

  /**
   * Link this account to a Telegram chat.
   *
   * With no chatId supplied, the most recent chat that messaged the bot wins.
   * That is a deliberate simplification: on a self-hosted instance the person
   * pressing Connect is the person who just messaged the bot. A multi-tenant
   * deployment would issue a one-time code and match on it instead.
   */
  async link(userId: string, dto: LinkTelegramDto) {
    let chatId = dto.chatId?.trim();

    if (!chatId) {
      const updates = await this.call<TelegramUpdate[]>('getUpdates');
      const chats = updates
        .map((update) => update.message?.chat)
        .filter((chat): chat is NonNullable<typeof chat> => Boolean(chat));

      if (chats.length === 0) {
        throw new BadRequestException(
          'No recent messages to the bot. Open Telegram, send the bot any message ' +
            '(for example /start), then press Connect again.',
        );
      }
      chatId = String(chats[chats.length - 1].id);
    }

    await this.prisma.userPreferences.upsert({
      where: { userId },
      create: { userId, telegramChatId: chatId },
      update: { telegramChatId: chatId },
    });

    await this.call('sendMessage', {
      chat_id: chatId,
      text:
        '✅ *Connected*\n\nThis chat will now receive trading signals — entry, stop, ' +
        'targets, reward:risk and the reasoning behind each one.\n\n' +
        '_Not investment advice. Probabilities are historical frequencies, not promises._',
      parse_mode: 'Markdown',
    });

    return { linked: true, chatId, message: 'Telegram connected — a test message has been sent.' };
  }

  async unlink(userId: string) {
    await this.prisma.userPreferences.updateMany({
      where: { userId },
      data: { telegramChatId: null },
    });
    return { linked: false, message: 'Telegram disconnected.' };
  }

  /** Send a realistic sample so the user can see what a signal looks like. */
  async test(userId: string) {
    const preferences = await this.prisma.userPreferences.findUnique({
      where: { userId },
      select: { telegramChatId: true },
    });

    if (!preferences?.telegramChatId) {
      throw new BadRequestException('Telegram is not connected for this account.');
    }

    await this.call('sendMessage', {
      chat_id: preferences.telegramChatId,
      parse_mode: 'Markdown',
      text: [
        '*BUY RELIANCE · 1D · 68/100*',
        '',
        'Entry 1307.80 · SL 1271.30',
        'TP1 1344.30 · TP2 1380.80 · TP3 1417.30',
        'R:R 1.98:1 · confidence 68/100',
        '',
        'Sample message — this is what a live signal will look like.',
        '',
        '_Not investment advice._',
      ].join('\n'),
    });

    return { sent: true, message: 'Test message sent to your Telegram.' };
  }
}

@ApiTags('notifications')
@Controller('notifications/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get()
  @ApiOperation({ summary: 'Telegram connection status for the current user' })
  status(@CurrentUser('id') userId: string) {
    return this.telegram.status(userId);
  }

  @Post('link')
  @ApiOperation({ summary: 'Connect Telegram — discovers the chat id if not supplied' })
  link(@CurrentUser('id') userId: string, @Body() dto: LinkTelegramDto) {
    return this.telegram.link(userId, dto);
  }

  @Post('test')
  @ApiOperation({ summary: 'Send a sample signal to the connected chat' })
  test(@CurrentUser('id') userId: string) {
    return this.telegram.test(userId);
  }

  @Delete()
  @ApiOperation({ summary: 'Disconnect Telegram' })
  unlink(@CurrentUser('id') userId: string) {
    return this.telegram.unlink(userId);
  }
}
