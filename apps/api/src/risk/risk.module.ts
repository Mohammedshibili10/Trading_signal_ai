import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { Public } from '../common/decorators';

class PositionSizeDto {
  @IsNumber() @Min(1) capital!: number;
  /** Hard ceiling at 5. Anything above that is not position sizing. */
  @IsNumber() @Min(0.05) @Max(5) riskPercent!: number;
  @IsNumber() @Min(0) entry!: number;
  @IsNumber() @Min(0) stopLoss!: number;
  @IsOptional() @IsNumber() @Min(0) target?: number;
  @IsOptional() @IsNumber() @Min(1) lotSize?: number;
}

class KellyDto {
  @IsNumber() @Min(0) @Max(1) winRate!: number;
  @IsNumber() @Min(0) averageWin!: number;
  @IsNumber() @Min(0) averageLoss!: number;
}

class MonteCarloDto {
  /** Per-trade returns as fractions, e.g. 0.02 for +2%. */
  @IsArray() tradeReturns!: number[];
  @IsNumber() @Min(1) startingCapital!: number;
  @IsOptional() @IsNumber() @Min(100) @Max(20_000) simulations?: number;
  @IsOptional() @IsNumber() @Min(5) @Max(2000) horizon?: number;
}

class AtrStopDto {
  @IsNumber() @Min(0) entry!: number;
  @IsNumber() @Min(0) atr!: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(10) multiplier?: number;
  @IsOptional() @IsBoolean() long?: boolean;
}

class TrailingStopDto {
  @IsNumber() @Min(0) entry!: number;
  @IsNumber() @Min(0) currentPrice!: number;
  @IsNumber() @Min(0) highest!: number;
  @IsNumber() @Min(0) atr!: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(10) multiplier?: number;
  @IsOptional() @IsBoolean() long?: boolean;
}

/**
 * Risk calculators.
 *
 * Every one of these is a pure function of its inputs, so this is a thin proxy
 * onto the engine rather than a second implementation. Duplicating the maths in
 * TypeScript would mean the number a user sizes a trade with could disagree
 * with the number the signal engine used — which is the one bug in this whole
 * area that actually costs money.
 *
 * Public because none of it touches user data, and the position-size calculator
 * is useful on the marketing surface.
 */
@Injectable()
export class RiskService {
  constructor(private readonly ai: AiClientService) {}

  positionSize(dto: PositionSizeDto) {
    return this.ai.post('/risk/position-size', dto, { timeoutMs: 10_000 });
  }

  kelly(dto: KellyDto) {
    return this.ai.post('/risk/kelly', dto, { timeoutMs: 10_000 });
  }

  monteCarlo(dto: MonteCarloDto) {
    return this.ai.post(
      '/risk/monte-carlo',
      { simulations: 2000, horizon: 100, ...dto },
      // Bootstrapping thousands of paths is the one risk call that is not instant.
      { timeoutMs: 30_000 },
    );
  }

  atrStop(dto: AtrStopDto) {
    return this.ai.post('/risk/atr-stop', { multiplier: 2, long: true, ...dto }, { timeoutMs: 10_000 });
  }

  trailingStop(dto: TrailingStopDto) {
    return this.ai.post('/risk/trailing-stop', { multiplier: 2.5, long: true, ...dto }, { timeoutMs: 10_000 });
  }
}

@ApiTags('risk')
@Controller('risk')
class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Public()
  @Post('position-size')
  @ApiOperation({ summary: 'Position size from capital, risk budget and stop distance' })
  positionSize(@Body() dto: PositionSizeDto) {
    return this.risk.positionSize(dto);
  }

  @Public()
  @Post('kelly')
  @ApiOperation({ summary: 'Kelly fraction, with the half-Kelly a human should actually use' })
  kelly(@Body() dto: KellyDto) {
    return this.risk.kelly(dto);
  }

  @Public()
  @Post('monte-carlo')
  @ApiOperation({ summary: 'Bootstrap the distribution of outcomes from a trade series' })
  monteCarlo(@Body() dto: MonteCarloDto) {
    return this.risk.monteCarlo(dto);
  }

  @Public()
  @Post('atr-stop')
  @ApiOperation({ summary: 'Volatility-scaled stop from ATR' })
  atrStop(@Body() dto: AtrStopDto) {
    return this.risk.atrStop(dto);
  }

  @Public()
  @Post('trailing-stop')
  @ApiOperation({ summary: 'Trailing stop from the run-up high' })
  trailingStop(@Body() dto: TrailingStopDto) {
    return this.risk.trailingStop(dto);
  }
}

@Module({
  imports: [AnalysisModule],
  controllers: [RiskController],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
