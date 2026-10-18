import { redirect } from 'next/navigation';
import { isSignedIn } from '@/lib/session';
import { passwordConfigured } from '@/lib/auth';
import LoginForm from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await isSignedIn()) redirect('/');
  return (
    <div className="card login">
      <h1>Localization Review</h1>
      {passwordConfigured() ? (
        <LoginForm />
      ) : (
        <p className="notice error">
          Login is not configured yet. Set <code>REVIEW_ADMIN_PASSWORD</code> (at least 12 characters) in the service variables.
        </p>
      )}
    </div>
  );
}
