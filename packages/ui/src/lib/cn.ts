import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later Tailwind classes win over earlier ones.
 *
 * Why this matters: without it, `<Button className="px-8">` would not override
 * the button's built-in `px-4` — both classes would be present and CSS source
 * order would decide, which is not something a component author controls.
 * `twMerge` understands Tailwind's groups and drops the loser.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
