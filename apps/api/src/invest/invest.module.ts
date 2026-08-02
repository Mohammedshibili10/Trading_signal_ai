import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { InvestmentAnalysisService } from './investment-analysis.service';
import { CurrentUser, Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

class SipDto {
  @IsNumber() @Min(100) monthlyAmount!: number;
  @IsNumber() @Min(1) @Max(50) years!: number;
  @IsNumber() @Min(1) @Max(40) expectedReturn!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(50) stepUpPercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(20) inflationRate?: number;
}

class GoalDto {
  @IsString() name!: string;
  @IsNumber() @Min(1000) targetAmount!: number;
  @IsOptional() @IsNumber() @Min(0) currentSavings?: number;
  @IsNumber() @Min(1) @Max(50) years!: number;
  @IsOptional() @IsNumber() @Min(1) @Max(40) expectedReturn?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(20) inflationRate?: number;
}

class RetirementDto {
  @IsNumber() @Min(18) @Max(75) currentAge!: number;
  @IsNumber() @Min(30) @Max(80) retirementAge!: number;
  @IsNumber() @Min(1000) monthlyExpenses!: number;
  @IsOptional() @IsNumber() @Min(0) currentCorpus?: number;
  @IsOptional() @IsNumber() inflationRate?: number;
  @IsOptional() @IsNumber() preReturn?: number;
  @IsOptional() @IsNumber() postReturn?: number;
  @IsOptional() @IsNumber() lifeExpectancy?: number;
}

@Injectable()
class InvestService {
  constructor(
    private readonly ai: AiClientService,
    private readonly prisma: PrismaService,
  ) {}

  sip(dto: SipDto) {
    return this.ai.post('/invest/sip', dto, { timeoutMs: 10_000 });
  }

  retirement(dto: RetirementDto) {
    return this.ai.post('/invest/retirement', dto, { timeoutMs: 10_000 });
  }

  async createGoal(userId: string, dto: GoalDto) {
    // Compute the plan once at save time so the dashboard doesn't recompute it
    // on every render.
    const plan = await this.ai
      .post('/invest/goal', dto, { timeoutMs: 10_000 })
      .catch(() => null);

    return this.prisma.goal.create({
      data: {
        userId,
        name: dto.name,
        targetAmount: dto.targetAmount,
        currentSavings: dto.currentSavings ?? 0,
        years: dto.years,
        expectedReturn: dto.expectedReturn ?? 12,
        inflationRate: dto.inflationRate ?? 6,
        plan: (plan as never) ?? undefined,
      },
    });
  }

  goals(userId: string) {
    return this.prisma.goal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async deleteGoal(userId: string, id: string) {
    const result = await this.prisma.goal.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('Goal not found');
    return { message: 'Goal deleted' };
  }
}

@ApiTags('invest')
@Controller('invest')
class InvestController {
  constructor(
    private readonly invest: InvestService,
    private readonly investment: InvestmentAnalysisService,
  ) {}

  @Public()
  @Get('analysis/:symbol')
  @ApiOperation({
    summary: 'Investment view for one instrument — recommendation, scores, screening, targets',
  })
  analysis(@Param('symbol') symbol: string, @Query('ethical') ethical?: string) {
    return this.investment.analyseSymbol(symbol, { ethicalMode: ethical === 'true' });
  }

  @Public()
  @Get('screen')
  @ApiOperation({ summary: 'Rank the investable universe, optionally by style' })
  screen(
    @Query('style') style?: string,
    @Query('ethical') ethical?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investment.screen({
      style,
      ethicalMode: ethical === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('portfolio-health')
  @ApiOperation({ summary: 'Diversification, health score and rebalancing observations' })
  portfolioHealth(@CurrentUser('id') userId: string) {
    return this.investment.portfolioHealth(userId);
  }

  @Public()
  @Post('sip')
  @ApiOperation({ summary: 'SIP projection with step-up and inflation adjustment' })
  sip(@Body() dto: SipDto) { return this.invest.sip(dto); }

  @Public()
  @Post('retirement')
  @ApiOperation({ summary: 'Retirement corpus and the SIP required to reach it' })
  retirement(@Body() dto: RetirementDto) { return this.invest.retirement(dto); }

  @Get('goals')
  @ApiOperation({ summary: 'Your saved goals' })
  goals(@CurrentUser('id') userId: string) { return this.invest.goals(userId); }

  @Post('goals')
  @ApiOperation({ summary: 'Create a goal and compute its plan' })
  createGoal(@CurrentUser('id') userId: string, @Body() dto: GoalDto) {
    return this.invest.createGoal(userId, dto);
  }

  @Delete('goals/:id')
  deleteGoal(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.invest.deleteGoal(userId, id);
  }
}

@Module({
  imports: [AnalysisModule, MarketDataModule],
  controllers: [InvestController],
  providers: [InvestService, InvestmentAnalysisService],
  exports: [InvestmentAnalysisService],
})
export class InvestModule {}
