import { Body, Controller, Get, Injectable, Module, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { AnalysisService } from '../analysis/analysis.service';
import { CurrentUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { Timeframe } from '../market-data/providers/provider.interface';

class AskDto {
  @IsString() @MinLength(2) @MaxLength(2000) question!: string;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsString() timeframe?: string;
  @IsOptional() @IsString() sessionId?: string;
}

@Injectable()
class AssistantService {
  constructor(
    private readonly ai: AiClientService,
    private readonly analysis: AnalysisService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Answer a question, grounded in the current analysis.
   *
   * When a symbol is supplied we run the analysis first and pass it as context.
   * The AI service is forbidden from introducing claims that aren't in that
   * context — the model rephrases, it never decides. See the engine's
   * assistant module for the enforcement.
   */
  async ask(userId: string, dto: AskDto) {
    let context: unknown = null;

    if (dto.symbol) {
      context = await this.analysis
        .analyse(dto.symbol, (dto.timeframe as Timeframe) ?? '1D', { withCalibration: false })
        .catch(() => null);
    }

    const session = await this.resolveSession(userId, dto.sessionId, dto.symbol, dto.question);

    const history = await this.prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { role: true, content: true },
    });

    const answer = await this.ai.post<{ answer: string; model: string; source: string }>(
      '/assistant',
      {
        question: dto.question,
        symbol: dto.symbol,
        context,
        history: history.reverse(),
      },
      { timeoutMs: 30_000 },
    );

    await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: { sessionId: session.id, role: 'user', content: dto.question },
      }),
      this.prisma.chatMessage.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          content: answer.answer,
          context: dto.symbol ? ({ symbol: dto.symbol, model: answer.model } as never) : undefined,
        },
      }),
      this.prisma.chatSession.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      }),
    ]);

    return { ...answer, sessionId: session.id };
  }

  private async resolveSession(
    userId: string,
    sessionId: string | undefined,
    symbol: string | undefined,
    question: string,
  ) {
    if (sessionId) {
      const existing = await this.prisma.chatSession.findFirst({
        where: { id: sessionId, userId },
      });
      if (existing) return existing;
    }

    return this.prisma.chatSession.create({
      data: {
        userId,
        symbol,
        // First question becomes the title, so the history list is scannable.
        title: question.slice(0, 60) + (question.length > 60 ? '…' : ''),
      },
    });
  }

  sessions(userId: string) {
    return this.prisma.chatSession.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 30,
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 2 } },
    });
  }

  messages(userId: string, sessionId: string) {
    return this.prisma.chatMessage.findMany({
      where: { sessionId, session: { userId } },
      orderBy: { createdAt: 'asc' },
    });
  }

  status() {
    return this.ai.get('/assistant/status');
  }
}

@ApiTags('assistant')
@Controller('assistant')
class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('ask')
  // LLM calls cost money and latency; cap them per user.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ask a question grounded in the current analysis' })
  ask(@CurrentUser('id') userId: string, @Body() dto: AskDto) {
    return this.assistant.ask(userId, dto);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Conversation history' })
  sessions(@CurrentUser('id') userId: string) {
    return this.assistant.sessions(userId);
  }

  @Get('messages')
  @ApiOperation({ summary: 'Messages in one conversation' })
  messages(@CurrentUser('id') userId: string, @Query('sessionId') sessionId: string) {
    return this.assistant.messages(userId, sessionId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Which assistant backend is active' })
  status() {
    return this.assistant.status();
  }
}

@Module({
  imports: [AnalysisModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
