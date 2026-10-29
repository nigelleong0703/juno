import type { TaskSpec } from '../types';
import { appleMacMini } from './apple-mac-mini';
import { detergentCheapestPlatform } from './detergent-cheapest-platform';
import { expenseTracker } from './expense-tracker';
import { klWeekendPlan } from './kl-weekend-plan';
import { pptxSingaporeFood } from './pptx-singapore-food';
import { accessDeniedControl, preorderNotYet } from './preorder-not-yet';
import { researchPageSilent } from './research-page-silent';
import { readTwoBooksGoal } from './read-two-books-goal';
import { rememberNoSpicy } from './remember-no-spicy';
import { tokyoItinerary } from './tokyo-itinerary';
import { waterReminder } from './water-reminder';
import { weatherSingapore } from './weather-singapore';
import { xiaohongshuLogin } from './xiaohongshu-login';

/** Every real-task case, in the order they run. `E2E_TASKS=id,id` runs a subset. */
export const TASKS: TaskSpec[] = [appleMacMini, pptxSingaporeFood, tokyoItinerary, rememberNoSpicy, expenseTracker, weatherSingapore, waterReminder, readTwoBooksGoal, preorderNotYet, accessDeniedControl, researchPageSilent, klWeekendPlan, detergentCheapestPlatform, xiaohongshuLogin];
