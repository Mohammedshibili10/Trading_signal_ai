'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Check, TrendingUp, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { endpoints, setAccessToken } from '@/lib/api';
import { APP_NAME } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useAppDispatch } from '@/store/hooks';
import { setCredentials } from '@/store/slices/auth-slice';

// Mirrors the API's policy exactly. Enforcing it client-side too means the user
// finds out before a round trip, not after.
const schema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Enter a valid email address'),
  password: z
    .string()
    .min(10, 'At least 10 characters')
    .regex(/[a-z]/, 'Include a lower-case letter')
    .regex(/[A-Z]/, 'Include an upper-case letter')
    .regex(/\d/, 'Include a number'),
});

type FormValues = z.infer<typeof schema>;

const RULES = [
  { label: 'At least 10 characters', test: (value: string) => value.length >= 10 },
  { label: 'Lower-case letter', test: (value: string) => /[a-z]/.test(value) },
  { label: 'Upper-case letter', test: (value: string) => /[A-Z]/.test(value) },
  { label: 'Number', test: (value: string) => /\d/.test(value) },
];

export default function RegisterPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), mode: 'onChange' });

  const password = watch('password') ?? '';

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      const { data } = await endpoints.auth.register(values.email, values.name, values.password);
      setAccessToken(data.accessToken);
      dispatch(setCredentials({ user: data.user, accessToken: data.accessToken }));
      toast.success('Account created. Check your email to verify the address.');
      router.replace('/dashboard');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="aurora flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <TrendingUp className="size-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">{APP_NAME}</h1>
        </div>

        <Card className="p-6">
          <h2 className="text-[15px] font-semibold">Create your account</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Free to start. No card required.
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-5 flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoComplete="name"
                placeholder="Arjun Mehta"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                aria-invalid={Boolean(errors.email)}
                {...register('email')}
              />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                aria-invalid={Boolean(errors.password)}
                {...register('password')}
              />

              {password.length > 0 && (
                <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                  {RULES.map((rule) => {
                    const passed = rule.test(password);
                    return (
                      <li
                        key={rule.label}
                        className={cn(
                          'flex items-center gap-1 text-[11px]',
                          passed ? 'text-bull' : 'text-muted-foreground',
                        )}
                      >
                        {passed ? <Check className="size-3" /> : <X className="size-3" />}
                        {rule.label}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <Button type="submit" loading={submitting} className="mt-1 w-full">
              Create account
            </Button>
          </form>

          <p className="mt-5 text-center text-[13px] text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
