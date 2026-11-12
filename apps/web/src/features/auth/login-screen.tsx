import { useTranslation } from 'react-i18next';

import { LoginForm } from './login-form';
import { useServers } from './use-session';

export const LoginScreen = () => {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const { data: servers } = useServers();

  return (
    <div className="bg-app flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-5 text-center">
          {/* T3Foundry cube mark in a white circle with soft drop shadow */}
          <div className="flex size-20 items-center justify-center rounded-full bg-white shadow-md">
            <img src="/brand/t3f-cube.png" alt="" className="size-16 object-contain" />
          </div>

          {/* Full wordmark logo; app name kept as sr-only for accessibility */}
          <img src="/brand/t3f-full-logo.png" alt={tCommon('appName')} className="h-10 w-auto object-contain" />
          <h1 className="sr-only">{tCommon('appName')}</h1>

          <p className="text-content-muted text-sm">{t('title')}</p>
        </div>

        <LoginForm
          servers={servers?.servers ?? []}
          defaultServerId={servers?.defaultServerId ?? undefined}
          className="bg-panel border-line space-y-4 rounded-2xl border p-6 shadow-sm"
        />

        <p className="text-content-muted mt-6 text-center text-xs leading-relaxed whitespace-pre-line">
          {t('disclaimer')}
        </p>
      </div>
    </div>
  );
};
