import {
  Activity,
  BadgeCheck,
  CircleDollarSign,
  Code2,
  Globe,
  LayoutGrid,
  Map,
  Receipt,
  Settings,
  Tag,
  Users,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

/** Nav entries store an icon NAME so the nav model stays serialisable data. */
export const NAV_ICONS: Record<string, ReactNode> = {
  layout: <LayoutGrid />,
  station: <Zap />,
  map: <Map />,
  activity: <Activity />,
  code: <Code2 />,
  users: <Users />,
  card: <BadgeCheck />,
  tag: <Tag />,
  receipt: <Receipt />,
  globe: <Globe />,
  check: <CircleDollarSign />,
  settings: <Settings />,
};
