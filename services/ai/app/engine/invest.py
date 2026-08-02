"""
Long-horizon investment maths.

Deliberately separate from the trading engine. Investing and trading are
different disciplines with different time constants, and blurring them is how
people end up "investing" in a failed swing trade.

All figures are nominal unless explicitly inflation-adjusted. Indian financial
planning should assume ~6% inflation, so the real number is always shown next to
the nominal one — a ₹1 crore corpus in 25 years is not ₹1 crore of today's money.

Spec: docs/trading-concepts.md §11.
"""

from __future__ import annotations

from typing import Any


def sip_projection(
    *,
    monthly_amount: float,
    years: int,
    expected_return: float,
    step_up_percent: float = 0.0,
    inflation_rate: float = 6.0,
) -> dict[str, Any]:
    """
    Future value of a monthly SIP.

    Contributions are treated as an **annuity-due** — invested at the start of
    each month, which is how SIP mandates actually execute. Using an ordinary
    annuity understates the corpus by roughly one month's growth.

    Step-up SIPs raise the contribution annually; the increase compounds too,
    which is why a 10% annual step-up changes the outcome far more than most
    people expect.
    """
    monthly_rate = expected_return / 100.0 / 12.0
    schedule: list[dict[str, Any]] = []

    balance = 0.0
    invested = 0.0
    contribution = monthly_amount

    for year in range(1, years + 1):
        for _ in range(12):
            # Annuity-due: contribute, then grow the whole balance.
            balance = (balance + contribution) * (1 + monthly_rate)
            invested += contribution
        schedule.append({
            "year": year,
            "invested": round(invested, 2),
            "value": round(balance, 2),
        })
        contribution *= 1 + step_up_percent / 100.0

    real_value = balance / ((1 + inflation_rate / 100.0) ** years)

    return {
        "monthlyAmount": round(monthly_amount, 2),
        "years": years,
        "expectedReturn": expected_return,
        "stepUpPercent": step_up_percent,
        "totalInvested": round(invested, 2),
        "estimatedValue": round(balance, 2),
        "wealthGain": round(balance - invested, 2),
        "inflationAdjustedValue": round(real_value, 2),
        "schedule": schedule,
        "note": (
            f"₹{balance:,.0f} nominal is worth about ₹{real_value:,.0f} in today's money at "
            f"{inflation_rate:.0f}% inflation. Returns are assumed, not guaranteed — "
            "equity funds have delivered negative returns over five-year windows before."
        ),
    }


def lumpsum_projection(
    *, amount: float, years: int, expected_return: float, inflation_rate: float = 6.0
) -> dict[str, Any]:
    value = amount * ((1 + expected_return / 100.0) ** years)
    real = value / ((1 + inflation_rate / 100.0) ** years)
    return {
        "amount": round(amount, 2),
        "years": years,
        "estimatedValue": round(value, 2),
        "wealthGain": round(value - amount, 2),
        "inflationAdjustedValue": round(real, 2),
    }


def goal_plan(
    *,
    name: str,
    target_amount: float,
    current_savings: float,
    years: int,
    expected_return: float = 12.0,
    inflation_rate: float = 6.0,
) -> dict[str, Any]:
    """
    Work out the monthly contribution a goal needs.

    Inflates the target **first**. Planning ₹50 lakh for a child's education in
    18 years against today's fees is the most common and most expensive mistake
    in Indian goal planning — at 6% inflation that goal actually costs ₹1.43 cr.
    """
    inflated_target = target_amount * ((1 + inflation_rate / 100.0) ** years)

    monthly_rate = expected_return / 100.0 / 12.0
    months = years * 12

    # What the existing corpus grows into on its own.
    future_of_current = current_savings * ((1 + monthly_rate) ** months)
    shortfall = max(0.0, inflated_target - future_of_current)

    if monthly_rate > 0:
        # Annuity-due factor, matching sip_projection.
        factor = (((1 + monthly_rate) ** months - 1) / monthly_rate) * (1 + monthly_rate)
        required_monthly = shortfall / factor if factor > 0 else 0.0
    else:
        required_monthly = shortfall / months if months else 0.0

    allocation = suggest_allocation(years)

    return {
        "name": name,
        "targetAmount": round(target_amount, 2),
        "currentSavings": round(current_savings, 2),
        "years": years,
        "expectedReturn": expected_return,
        "inflationRate": inflation_rate,
        "inflationAdjustedTarget": round(inflated_target, 2),
        "futureValueOfCurrentSavings": round(future_of_current, 2),
        "requiredMonthly": round(required_monthly, 2),
        "onTrack": shortfall <= 0,
        "shortfall": round(shortfall, 2),
        "suggestedAllocation": allocation,
        "note": (
            f"₹{target_amount:,.0f} today costs ₹{inflated_target:,.0f} in {years} years at "
            f"{inflation_rate:.0f}% inflation. "
            + (
                "Existing savings already cover it if returns hold."
                if shortfall <= 0
                else f"You need about ₹{required_monthly:,.0f} a month to close the gap."
            )
        ),
    }


def suggest_allocation(years: int) -> list[dict[str, Any]]:
    """
    Asset allocation by horizon.

    Horizon, not age, is the right variable for a goal: a 30-year-old saving for
    a house purchase in two years should not be in equity. Allocation is the
    dominant driver of long-run outcome — far more than fund selection.
    """
    if years <= 2:
        return [
            {"assetClass": "Debt funds / FD", "percent": 80,
             "rationale": "Under two years there is no time to recover from an equity drawdown."},
            {"assetClass": "Gold", "percent": 10, "rationale": "Small hedge with low correlation to debt."},
            {"assetClass": "Equity", "percent": 10, "rationale": "Token growth allocation only."},
        ]
    if years <= 5:
        return [
            {"assetClass": "Equity (index / large cap)", "percent": 45,
             "rationale": "Enough horizon for meaningful growth, not enough for aggressive risk."},
            {"assetClass": "Debt funds", "percent": 40, "rationale": "Stabilises the portfolio near the goal date."},
            {"assetClass": "Gold", "percent": 15, "rationale": "Diversifier that historically holds up when equity falls."},
        ]
    if years <= 10:
        return [
            {"assetClass": "Equity (index + flexi cap)", "percent": 65,
             "rationale": "Long enough that equity volatility is an opportunity rather than a threat."},
            {"assetClass": "Debt funds", "percent": 25, "rationale": "Ballast and rebalancing fuel."},
            {"assetClass": "Gold", "percent": 10, "rationale": "Crisis hedge."},
        ]
    return [
        {"assetClass": "Equity (index + flexi + mid cap)", "percent": 75,
         "rationale": "Over a decade-plus horizon equity has been the only reliable inflation-beater in India."},
        {"assetClass": "Debt funds", "percent": 15, "rationale": "Rebalancing reserve, not a return driver."},
        {"assetClass": "Gold", "percent": 10, "rationale": "Long-run diversifier."},
    ]


def retirement_plan(
    *,
    current_age: int,
    retirement_age: int,
    monthly_expenses: float,
    current_corpus: float = 0.0,
    inflation_rate: float = 6.0,
    pre_return: float = 12.0,
    post_return: float = 8.0,
    life_expectancy: int = 85,
) -> dict[str, Any]:
    """
    Corpus required at retirement, and the SIP needed to get there.

    Uses the **real** (inflation-adjusted) return during retirement rather than
    the nominal one. Withdrawing at a nominal 8% while inflation runs at 6%
    depletes a corpus far faster than a nominal calculation suggests.
    """
    years_to_retire = max(0, retirement_age - current_age)
    years_in_retirement = max(1, life_expectancy - retirement_age)

    # Expenses at retirement, in future rupees.
    future_monthly = monthly_expenses * ((1 + inflation_rate / 100.0) ** years_to_retire)
    annual_at_retirement = future_monthly * 12

    real_return = (1 + post_return / 100.0) / (1 + inflation_rate / 100.0) - 1

    if abs(real_return) < 1e-6:
        corpus_needed = annual_at_retirement * years_in_retirement
    else:
        # Present value of an inflation-adjusted annuity.
        corpus_needed = annual_at_retirement * (1 - (1 + real_return) ** -years_in_retirement) / real_return

    monthly_rate = pre_return / 100.0 / 12.0
    months = years_to_retire * 12
    future_corpus = current_corpus * ((1 + monthly_rate) ** months) if months else current_corpus
    shortfall = max(0.0, corpus_needed - future_corpus)

    if months > 0 and monthly_rate > 0:
        factor = (((1 + monthly_rate) ** months - 1) / monthly_rate) * (1 + monthly_rate)
        required_sip = shortfall / factor if factor > 0 else 0.0
    else:
        required_sip = shortfall

    return {
        "currentAge": current_age,
        "retirementAge": retirement_age,
        "yearsToRetirement": years_to_retire,
        "yearsInRetirement": years_in_retirement,
        "currentMonthlyExpenses": round(monthly_expenses, 2),
        "monthlyExpensesAtRetirement": round(future_monthly, 2),
        "corpusRequired": round(corpus_needed, 2),
        "futureValueOfCurrentCorpus": round(future_corpus, 2),
        "shortfall": round(shortfall, 2),
        "requiredMonthlySip": round(required_sip, 2),
        "realReturnInRetirement": round(real_return * 100, 2),
        "suggestedAllocation": suggest_allocation(years_to_retire),
        "note": (
            f"₹{monthly_expenses:,.0f} of today's monthly spending becomes ₹{future_monthly:,.0f} "
            f"in {years_to_retire} years. Sustaining that for {years_in_retirement} years needs about "
            f"₹{corpus_needed:,.0f}. The real return in retirement is only {real_return * 100:.1f}% "
            "once inflation is netted off — which is the number that matters, not the headline 8%."
        ),
    }
