import {
  Bell,
  BookOpen,
  Bot,
  Briefcase,
  CandlestickChart,
  LayoutDashboard,
  LineChart,
  Newspaper,
  PiggyBank,
  Radar,
  Activity,
  BarChart3,
  Brain,
  ClipboardList,
  FlaskConical,
  Settings,
  Shield,
  Target,
  Timer,
  Star,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the command palette and tooltips. */
  description: string;
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Primary navigation.
 *
 * Grouped rather than a flat list of fifteen links — the brief asks for a
 * dashboard a beginner can use, and grouping is what keeps a feature-dense
 * product from reading as a control panel.
 */
export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        href: '/dashboard',
        label: 'Dashboard',
        icon: LayoutDashboard,
        description: 'Portfolio, signals and market summary',
      },
      {
        href: '/markets',
        label: 'Markets',
        icon: LineChart,
        description: 'Stocks, forex, crypto and investment products',
      },
      {
        href: '/watchlist',
        label: 'Watchlist',
        icon: Star,
        description: 'Instruments you follow',
      },
    ],
  },
  {
    label: 'Analysis',
    items: [
      {
        href: '/signals',
        label: 'AI Signals',
        icon: CandlestickChart,
        description: 'Probability-based trade ideas with calibration',
      },
      {
        href: '/scanners',
        label: 'Scanners',
        icon: Radar,
        description: 'Breakouts, momentum, volume and fundamentals',
      },
      {
        href: '/news',
        label: 'News',
        icon: Newspaper,
        description: 'Market news with sentiment classification',
      },
      {
        href: '/assistant',
        label: 'Assistant',
        icon: Bot,
        description: 'Ask questions about any setup',
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      {
        href: '/portfolio',
        label: 'Portfolio',
        icon: Briefcase,
        description: 'Holdings, P&L and allocation',
      },
      {
        href: '/risk',
        label: 'Risk',
        icon: Shield,
        description: 'Position sizing, limits and Monte Carlo',
      },
      {
        href: '/invest',
        label: 'Invest',
        icon: PiggyBank,
        description: 'SIP, goals and retirement planning',
      },
      {
        href: '/strategies',
        label: 'Strategies',
        icon: Wrench,
        description: 'Build and backtest without code',
      },
    ],
  },
  {
    label: 'Backtesting & Analytics',
    items: [
      {
        href: '/analytics',
        label: 'Dashboard',
        icon: BarChart3,
        description: 'Win rate, expectancy, drawdown and profit factor across every signal',
      },
      {
        href: '/analytics/backtesting',
        label: 'Backtesting',
        icon: FlaskConical,
        description: 'How every issued signal actually resolved against historical data',
      },
      {
        href: '/analytics/journal',
        label: 'Trade Journal',
        icon: ClipboardList,
        description: 'Every trade with entry, exit, R multiple and the AI post-mortem',
      },
      {
        href: '/analytics/intraday',
        label: 'Intraday Analytics',
        icon: Timer,
        description: 'Scalping, intraday, swing and positional broken out separately',
      },
      {
        href: '/analytics/strategies',
        label: 'Strategy Performance',
        icon: Activity,
        description: 'Per-method reliability — SMC, order blocks, RSI, volume and the rest',
      },
      {
        href: '/analytics/learning',
        label: 'AI Learning',
        icon: Brain,
        description: 'What the engine has learned, and which weight changes it rejected',
      },
      {
        href: '/analytics/reports',
        label: 'Reports',
        icon: Target,
        description: 'Daily, weekly, monthly and yearly roll-ups with the equity curve',
      },
    ],
  },
  {
    label: 'Account',
    items: [
      { href: '/alerts', label: 'Alerts', icon: Bell, description: 'Price and signal alerts' },
      { href: '/settings', label: 'Settings', icon: Settings, description: 'Profile and preferences' },
      {
        href: '/methodology',
        label: 'Methodology',
        icon: BookOpen,
        description: 'How the engine actually works',
      },
      {
        href: '/admin',
        label: 'Admin',
        icon: Shield,
        description: 'Users, providers and analytics',
        adminOnly: true,
      },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV.flatMap((group) => group.items);
