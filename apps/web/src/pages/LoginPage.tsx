import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AUTH_DEFAULT_RETURN_TO,
  EmailAddressInputSchema,
  EmailOtpCodeSchema,
  sanitizeAuthReturnTo,
} from '@cb/shared';
import {
  AuthRequestError,
  probeAuthSession,
  requestEmailChallenge,
  verifyEmail,
} from '../api/auth.js';
import { logoutSession } from '../api/sessionLogout.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';

export type LoginUiState =
  | 'email'
  | 'sending'
  | 'code'
  | 'verifying'
  | 'confirming-session'
  | 'rate-wait'
  | 'dependency-error'
  | 'account-disabled';

type ChallengeMode = 'initial' | 'resend';
type FormStep = 'email' | 'code';
type ConfirmationReason = 'initial' | 'verification';
type RetryIntent =
  | 'confirm-initial'
  | 'confirm-verification'
  | 'challenge'
  | 'resend'
  | 'verification'
  | 'none';

interface DependencyErrorState {
  message: string;
  retryIntent: RetryIntent;
  backStep: FormStep;
}

export interface LoginPageProps {
  /** 测试注入点；生产默认整页导航，以便安全进入 /try 下的另一个前端 bundle。 */
  navigateAfterLogin?: (path: string) => void;
}

function defaultNavigateAfterLogin(path: string): void {
  window.location.assign(path);
}

export function maskLoginEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return '***';
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visibleLocal =
    local.length === 1
      ? `${local}***`
      : local.length === 2
        ? `${local[0]}***${local[1]}`
        : `${local.slice(0, 2)}***${local.at(-1)}`;
  return `${visibleLocal}@${domain}`;
}

function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1_000));
}

function asAuthError(cause: unknown): AuthRequestError {
  return cause instanceof AuthRequestError
    ? cause
    : new AuthRequestError('network', null, '登录请求暂时没有完成，请稍后重试。');
}

/** 完全由仓库内 React 渲染的邮箱验证码登录，不加载第三方认证页面或脚本。 */
export function LoginPage({
  navigateAfterLogin = defaultNavigateAfterLogin,
}: LoginPageProps): ReactElement {
  const [params] = useSearchParams();
  const returnTo = useMemo(
    () => sanitizeAuthReturnTo(params.get('returnTo') ?? AUTH_DEFAULT_RETURN_TO),
    [params],
  );
  const [state, setState] = useState<LoginUiState>('confirming-session');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('正在确认登录状态。');
  const [sendingMode, setSendingMode] = useState<ChallengeMode>('initial');
  const [confirmationReason, setConfirmationReason] = useState<ConfirmationReason>('initial');
  const [dependencyError, setDependencyError] = useState<DependencyErrorState | null>(null);
  const [disabledMessage, setDisabledMessage] = useState('当前账号已停用，请联系支持人员处理。');
  const [disabledLogoutPending, setDisabledLogoutPending] = useState(false);
  const [disabledLogoutError, setDisabledLogoutError] = useState<string | null>(null);
  const [rateResumeStep, setRateResumeStep] = useState<FormStep>('email');
  const [rateDeadline, setRateDeadline] = useState(0);
  const [resendDeadline, setResendDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const initialProbeStartedRef = useRef(false);
  const operationGenerationRef = useRef(0);

  useDocumentTitle('邮箱登录 · Combo');

  const finishLogin = useCallback(
    (target: string): void => {
      navigateAfterLogin(sanitizeAuthReturnTo(target));
    },
    [navigateAfterLogin],
  );

  const showDependencyError = useCallback(
    (message: string, retryIntent: RetryIntent, backStep: FormStep): void => {
      setDependencyError({ message, retryIntent, backStep });
      setLiveMessage(message);
      setState('dependency-error');
    },
    [],
  );

  const confirmSession = useCallback(
    async (reason: ConfirmationReason): Promise<void> => {
      const operationGeneration = ++operationGenerationRef.current;
      setConfirmationReason(reason);
      setLiveMessage(
        reason === 'verification' ? '正在确认登录是否已经完成。' : '正在确认登录状态。',
      );
      setState('confirming-session');
      const probe = await probeAuthSession();
      if (!mountedRef.current || operationGeneration !== operationGenerationRef.current) return;

      if (probe.status === 'authed') {
        finishLogin(returnTo);
        return;
      }
      if (probe.status === 'anon') {
        if (reason === 'verification') {
          setCodeError('暂时无法确认登录成功，请检查网络后再次提交验证码。');
          setLiveMessage('尚未确认登录成功，请再次提交验证码。');
          setState('code');
        } else {
          setLiveMessage('请输入邮箱获取登录验证码。');
          setState('email');
        }
        return;
      }
      if (probe.status === 'disabled') {
        setDisabledMessage(probe.error.message);
        setDisabledLogoutError(null);
        setLiveMessage('当前账号已停用，请联系支持人员处理。');
        setState('account-disabled');
        return;
      }

      showDependencyError(
        probe.error.message,
        reason === 'verification' ? 'confirm-verification' : 'confirm-initial',
        reason === 'verification' ? 'code' : 'email',
      );
    },
    [finishLogin, returnTo, showDependencyError],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!initialProbeStartedRef.current) {
      initialProbeStartedRef.current = true;
      void confirmSession('initial');
    }
    return () => {
      mountedRef.current = false;
    };
  }, [confirmSession]);

  useEffect(() => {
    if (state !== 'code' && state !== 'rate-wait') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state, rateDeadline, resendDeadline]);

  const rateRemaining = secondsUntil(rateDeadline, now);
  const resendRemaining = secondsUntil(resendDeadline, now);

  useEffect(() => {
    if (state !== 'rate-wait' || rateRemaining > 0) return;
    setLiveMessage(
      rateResumeStep === 'email'
        ? '现在可以重新获取验证码。'
        : '现在可以继续验证或重新发送验证码。',
    );
    setState(rateResumeStep);
  }, [rateRemaining, rateResumeStep, state]);

  useEffect(() => {
    if (state === 'email') emailRef.current?.focus();
    if (state === 'code') codeRef.current?.focus();
    if (state === 'dependency-error' || state === 'account-disabled') statusRef.current?.focus();
  }, [codeError, emailError, state]);

  const enterRateWait = (seconds: number | undefined, resumeStep: FormStep): void => {
    const waitSeconds = Math.max(1, seconds ?? 60);
    setNow(Date.now());
    setRateDeadline(Date.now() + waitSeconds * 1_000);
    setRateResumeStep(resumeStep);
    setLiveMessage(`操作太频繁了，请在 ${waitSeconds} 秒后重试。`);
    setState('rate-wait');
  };

  const sendChallenge = async (mode: ChallengeMode): Promise<void> => {
    const parsedEmail = EmailAddressInputSchema.safeParse(email);
    if (!parsedEmail.success) {
      setEmailError('请输入完整邮箱地址，且不要包含空格。');
      setLiveMessage('邮箱格式需要修改。');
      setState('email');
      return;
    }

    const submittedEmail = parsedEmail.data;
    const operationGeneration = ++operationGenerationRef.current;
    setSendingMode(mode);
    setEmailError(null);
    setCodeError(null);
    setLiveMessage(mode === 'resend' ? '正在重新发送验证码。' : '正在发送验证码。');
    setState('sending');

    try {
      const result = await requestEmailChallenge({ email: submittedEmail });
      if (!mountedRef.current || operationGeneration !== operationGenerationRef.current) return;
      setCode('');
      setNow(Date.now());
      setResendDeadline(Date.now() + result.resendAfterSeconds * 1_000);
      setLiveMessage('如果地址可用，验证码已发送。请查看收件箱。');
      setState('code');
    } catch (cause) {
      if (!mountedRef.current || operationGeneration !== operationGenerationRef.current) return;
      const error = asAuthError(cause);
      const resumeStep: FormStep = mode === 'initial' ? 'email' : 'code';
      if (error.status === 400) {
        if (mode === 'initial') {
          setEmailError(error.message);
          setState('email');
        } else {
          setCodeError(error.message);
          setState('code');
        }
        setLiveMessage(error.message);
        return;
      }
      if (error.status === 429) {
        enterRateWait(error.retryAfterSeconds, resumeStep);
        return;
      }
      showDependencyError(
        error.message,
        error.status === 403 ? 'none' : mode === 'initial' ? 'challenge' : 'resend',
        resumeStep,
      );
    }
  };

  const submitEmail = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void sendChallenge('initial');
  };

  const submitVerification = async (): Promise<void> => {
    const parsedCode = EmailOtpCodeSchema.safeParse(code);
    if (!parsedCode.success) {
      setCodeError('请输入邮件中的六位数字验证码。');
      setLiveMessage('验证码需要是六位数字。');
      setState('code');
      return;
    }

    const submittedEmail = email;
    const submittedCode = parsedCode.data;
    const operationGeneration = ++operationGenerationRef.current;
    setCodeError(null);
    setLiveMessage('正在验证验证码。');
    setState('verifying');
    try {
      const result = await verifyEmail({ email: submittedEmail, code: submittedCode, returnTo });
      if (!mountedRef.current || operationGeneration !== operationGenerationRef.current) return;
      finishLogin(result.returnTo);
    } catch (cause) {
      if (!mountedRef.current || operationGeneration !== operationGenerationRef.current) return;
      const error = asAuthError(cause);
      if (error.outcomeUncertain) {
        await confirmSession('verification');
        return;
      }
      if (error.status === 400 || error.status === 401) {
        setCodeError(error.message);
        setLiveMessage(error.message);
        setState('code');
        return;
      }
      if (error.status === 429) {
        enterRateWait(error.retryAfterSeconds, 'code');
        return;
      }
      showDependencyError(error.message, error.status === 403 ? 'none' : 'verification', 'code');
    }
  };

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitVerification();
  };

  const changeEmail = (): void => {
    operationGenerationRef.current += 1;
    setCode('');
    setCodeError(null);
    setEmailError(null);
    setDependencyError(null);
    setResendDeadline(0);
    setLiveMessage('请输入邮箱获取新的登录验证码。');
    setState('email');
  };

  const clearDisabledSession = async (): Promise<void> => {
    const operationGeneration = ++operationGenerationRef.current;
    setDisabledLogoutPending(true);
    setDisabledLogoutError(null);
    const result = await logoutSession();
    if (!mountedRef.current || operationGeneration !== operationGenerationRef.current) return;
    setDisabledLogoutPending(false);
    if (!result) {
      setDisabledLogoutError('暂时无法清除当前登录，请稍后再试或联系支持人员。');
      setLiveMessage('暂时无法清除当前登录。');
      return;
    }

    setCode('');
    setCodeError(null);
    setEmailError(null);
    setDependencyError(null);
    setResendDeadline(0);
    setLiveMessage('当前登录已清除，请输入其他邮箱。');
    setState('email');
  };

  const retryDependency = (): void => {
    const intent = dependencyError?.retryIntent ?? 'none';
    if (intent === 'confirm-initial') void confirmSession('initial');
    if (intent === 'confirm-verification') void confirmSession('verification');
    if (intent === 'challenge') void sendChallenge('initial');
    if (intent === 'resend') void sendChallenge('resend');
    if (intent === 'verification') void submitVerification();
    if (intent === 'none') changeEmail();
  };

  const emailPending = state === 'sending' && sendingMode === 'initial';
  const codePending = state === 'verifying' || (state === 'sending' && sendingMode === 'resend');
  const onCodeScreen =
    state === 'code' || state === 'verifying' || (state === 'sending' && sendingMode === 'resend');
  const inCodeContext =
    onCodeScreen ||
    (state === 'confirming-session' && confirmationReason === 'verification') ||
    (state === 'rate-wait' && rateResumeStep === 'code') ||
    (state === 'dependency-error' && dependencyError?.backStep === 'code');

  const renderEmailForm = (): ReactElement => (
    <form className="cb-login__form" noValidate onSubmit={submitEmail}>
      <div className="cb-login__field">
        <label htmlFor="login-email">邮箱</label>
        <input
          ref={emailRef}
          id="login-email"
          name="email"
          type="email"
          value={email}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
          required
          disabled={emailPending}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? 'login-email-error' : 'login-email-hint'}
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailError(null);
          }}
        />
        {emailError ? (
          <p id="login-email-error" className="cb-login__field-error">
            {emailError}
          </p>
        ) : (
          <p id="login-email-hint" className="cb-login__field-hint">
            我们会向这个地址发送一枚六位验证码。
          </p>
        )}
      </div>
      <button
        type="submit"
        className="cb-login__primary"
        disabled={emailPending}
        aria-busy={emailPending}
      >
        {emailPending ? '正在发送…' : '发送验证码'}
      </button>
      <p className="cb-login__privacy">邮箱仅用于建号、登录和必要的账号通知。</p>
    </form>
  );

  const renderCodeForm = (): ReactElement => (
    <form className="cb-login__form" noValidate onSubmit={submitCode}>
      <p className="cb-login__sent-to">
        验证码已发送至 <strong>{maskLoginEmail(email)}</strong>
      </p>
      <div className="cb-login__field">
        <label htmlFor="login-code">六位验证码</label>
        <input
          ref={codeRef}
          id="login-code"
          name="code"
          className="cb-login__code-input"
          type="text"
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          enterKeyHint="done"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          disabled={codePending}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? 'login-code-error' : 'login-code-hint'}
          onChange={(event) => {
            setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6));
            setCodeError(null);
          }}
        />
        {codeError ? (
          <p id="login-code-error" className="cb-login__field-error">
            {codeError}
          </p>
        ) : (
          <p id="login-code-hint" className="cb-login__field-hint">
            验证码五分钟内有效，并且只能使用一次。
          </p>
        )}
      </div>
      <button
        type="submit"
        className="cb-login__primary"
        disabled={codePending}
        aria-busy={state === 'verifying'}
      >
        {state === 'verifying' ? '正在验证…' : state === 'sending' ? '正在重新发送…' : '验证并登录'}
      </button>
      <div className="cb-login__secondary-actions">
        <button
          type="button"
          className="cb-login__text-action"
          disabled={codePending}
          onClick={changeEmail}
        >
          修改邮箱
        </button>
        <button
          type="button"
          className="cb-login__text-action"
          disabled={codePending || resendRemaining > 0}
          onClick={() => void sendChallenge('resend')}
        >
          {resendRemaining > 0 ? `${resendRemaining} 秒后可重发` : '重新发送验证码'}
        </button>
      </div>
    </form>
  );

  const retryLabel =
    dependencyError?.retryIntent === 'confirm-initial'
      ? '重新检查登录状态'
      : dependencyError?.retryIntent === 'confirm-verification'
        ? '再次确认登录'
        : dependencyError?.retryIntent === 'verification'
          ? '重试验证'
          : dependencyError?.retryIntent === 'none'
            ? '修改邮箱'
            : '重新发送验证码';

  const heading =
    state === 'confirming-session'
      ? confirmationReason === 'verification'
        ? '正在确认登录'
        : '正在检查会话'
      : state === 'rate-wait'
        ? '请稍等片刻'
        : state === 'account-disabled'
          ? '当前账号已停用'
          : state === 'dependency-error'
            ? '登录暂时无法完成'
            : onCodeScreen
              ? '输入六位验证码'
              : '使用邮箱登录';

  return (
    <section className="cb-page cb-login-page" aria-labelledby="cb-login-title">
      <div className="cb-login" data-state={state}>
        <p
          className="cb-login__step"
          aria-label={inCodeContext ? '登录步骤 2，共 2 步' : '登录步骤 1，共 2 步'}
        >
          {inCodeContext ? '步骤 2 / 2' : '步骤 1 / 2'}
        </p>
        <h1 className="cb-login__title" id="cb-login-title">
          {heading}
        </h1>
        <p className="cb-login__lead">
          {inCodeContext
            ? '输入邮件里的验证码，完成首次建号或登录。'
            : '无需密码。验证邮箱后即可进入创作者中心。'}
        </p>

        <div className="cb-login__panel">
          {state === 'email' || emailPending ? renderEmailForm() : null}
          {onCodeScreen ? renderCodeForm() : null}

          {state === 'confirming-session' ? (
            <div className="cb-login__status" aria-busy="true">
              <span className="cb-login__status-mark" aria-hidden="true" />
              <p>{liveMessage}</p>
              <small>不会重复提交验证码。</small>
            </div>
          ) : null}

          {state === 'rate-wait' ? (
            <div className="cb-login__status">
              <p>请求过于频繁，请在 {rateRemaining} 秒后再试。</p>
              <button type="button" className="cb-login__primary" disabled>
                {rateRemaining} 秒后可继续
              </button>
              {rateResumeStep === 'code' ? (
                <button type="button" className="cb-login__text-action" onClick={changeEmail}>
                  修改邮箱
                </button>
              ) : null}
            </div>
          ) : null}

          {state === 'dependency-error' && dependencyError ? (
            <div ref={statusRef} className="cb-login__status cb-login__status--error" tabIndex={-1}>
              <p>{dependencyError.message}</p>
              <div className="cb-login__error-actions">
                <button type="button" className="cb-login__primary" onClick={retryDependency}>
                  {retryLabel}
                </button>
                {dependencyError.backStep === 'code' && dependencyError.retryIntent !== 'none' ? (
                  <button
                    type="button"
                    className="cb-login__text-action"
                    onClick={() => {
                      setLiveMessage('请输入验证码继续登录。');
                      setState('code');
                    }}
                  >
                    返回输入验证码
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {state === 'account-disabled' ? (
            <div
              ref={statusRef}
              className="cb-login__status cb-login__status--error"
              role="alert"
              tabIndex={-1}
            >
              <p>{disabledMessage}</p>
              <small>停用状态不能通过重试解除，请联系支持人员处理。</small>
              <div className="cb-login__error-actions">
                <button
                  type="button"
                  className="cb-login__primary"
                  disabled={disabledLogoutPending}
                  onClick={() => void clearDisabledSession()}
                >
                  {disabledLogoutPending ? '正在清除当前登录…' : '清除当前登录并使用其他邮箱'}
                </button>
              </div>
              {disabledLogoutError ? <p>{disabledLogoutError}</p> : null}
            </div>
          ) : null}
        </div>

        <p className="cb-login__live" aria-live="polite" aria-atomic="true">
          {liveMessage}
        </p>
      </div>
    </section>
  );
}
