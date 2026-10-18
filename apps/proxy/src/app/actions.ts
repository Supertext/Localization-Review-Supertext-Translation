'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { ReviewRole } from '@supertext-review/shared';
import { checkPassword, createSession, SESSION_COOKIE } from '@/lib/auth';
import { clientIp, RateLimiter } from '@/lib/rate-limit';
import { requireAuth } from '@/lib/session';
import * as store from '@/lib/admin-store';
import { createLink, revokeLink } from '@/lib/review-links';

const loginAttempts = new RateLimiter(10, 15 * 60 * 1000);
// All failed logins together, whatever address they claim: past 100 in 15 minutes every attempt
// waits 3 seconds. A slowdown, not a lockout, so the right password always gets in.
const failedLogins = new RateLimiter(100, 15 * 60 * 1000);
const SLOWDOWN_MS = 3000;

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const h = await headers();
  if (!loginAttempts.take(clientIp(h))) return { error: 'Too many attempts. Wait 15 minutes and try again.' };
  if (!failedLogins.take('all', Date.now(), false)) await new Promise((r) => setTimeout(r, SLOWDOWN_MS));
  const pw = String(form.get('password') ?? '');
  if (!checkPassword(pw)) {
    failedLogins.take('all');
    return { error: 'Wrong password.' };
  }
  const session = createSession();
  if (!session) return { error: 'Login is not configured (REVIEW_ADMIN_PASSWORD missing or shorter than 12 characters).' };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: session.expires,
  });
  redirect('/');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

function id(form: FormData, field = 'id'): number {
  const n = Number(form.get(field));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${field}`);
  return n;
}

function clean(value: FormDataEntryValue | null, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** Supertext language codes: `de`, `de-CH`, `zh-Hans`, `gsw-u-sd-chzh`. */
function langCode(value: FormDataEntryValue | null): string | null {
  const v = clean(value, 40);
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(v) ? v : null;
}

export async function saveTenant(form: FormData): Promise<void> {
  await requireAuth();
  const fp = clean(form.get('fingerprint'), 64);
  await store.updateTenant(fp, clean(form.get('label'), 200), clean(form.get('notes'), 5000));
  revalidatePath(`/tenants/${fp}`);
}

/** Target prefixes from the textarea: one `<target language> <path prefix>` per line. */
function targetPrefixes(value: FormDataEntryValue | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const [lang, prefix] = line.trim().split(/\s+/);
    const code = langCode(lang ?? '');
    const p = store.normalizePrefix(prefix);
    if (code && p) out[code] = p;
  }
  return out;
}

function siteInput(form: FormData): Omit<store.SiteInput, 'tenant'> {
  const origin = store.normalizeOrigin(clean(form.get('origin'), 500));
  if (!origin) throw new Error('The site address must be an http(s) URL.');
  const name = clean(form.get('name'), 200) || new URL(origin).hostname;
  return {
    name,
    origin,
    sourceLang: langCode(form.get('source_lang')),
    sourcePrefix: store.normalizePrefix(clean(form.get('source_prefix'), 200)),
    targetPrefixes: targetPrefixes(form.get('target_prefixes')),
  };
}

export async function createSiteAction(form: FormData): Promise<void> {
  await requireAuth();
  const tenant = clean(form.get('tenant'), 64);
  if (!/^[0-9a-f]{64}$/.test(tenant)) throw new Error('Choose a tenant.');
  const siteId = await store.createSite({ tenant, ...siteInput(form) });
  redirect(`/sites/${siteId}`);
}

export async function updateSiteAction(form: FormData): Promise<void> {
  await requireAuth();
  const siteId = id(form);
  await store.updateSite(siteId, siteInput(form));
  revalidatePath(`/sites/${siteId}`);
}

export async function deleteSiteAction(form: FormData): Promise<void> {
  await requireAuth();
  await store.deleteSite(id(form));
  redirect('/sites');
}

export async function createLinkAction(form: FormData): Promise<void> {
  await requireAuth();
  const siteId = id(form, 'site_id');
  const target = langCode(form.get('target_lang'));
  if (!target) throw new Error('Enter the Supertext target language, e.g. fr-CH.');
  const role = (store.ROLES as string[]).includes(String(form.get('role'))) ? (String(form.get('role')) as ReviewRole) : 'customer';
  const days = Math.min(Math.max(Number(form.get('days')) || 30, 1), 365);
  await createLink(siteId, target, role, clean(form.get('label'), 200), days);
  revalidatePath(`/sites/${siteId}`);
}

export async function revokeLinkAction(form: FormData): Promise<void> {
  await requireAuth();
  await revokeLink(id(form));
  revalidatePath(`/sites/${id(form, 'site_id')}`);
}
