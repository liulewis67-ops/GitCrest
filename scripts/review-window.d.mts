import type { ElectronApplication, Page } from "playwright";
export function resetReviewViewport(page: Page): Promise<void>;
export function setReviewWindowSize(application: ElectronApplication, page: Page, size: { width: number; height: number }): Promise<void>;
export function withReviewWindowSize<T>(application: ElectronApplication, page: Page, size: { width: number; height: number }, action: () => Promise<T>): Promise<T>;
export function withReviewApp<T>(action: (application: ElectronApplication, page: Page) => Promise<T>): Promise<T>;
export function repairReviewWindows(endpoint: string): Promise<number>;
