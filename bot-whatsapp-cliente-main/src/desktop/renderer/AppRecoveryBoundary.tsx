import { Component, ErrorInfo, ReactNode } from "react";
import { APP_RESUMED } from "./browserResume";

export class AppRecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private retried = false;
  private timer?: ReturnType<typeof setTimeout>;

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidMount() { window.addEventListener(APP_RESUMED, this.retryAfterResume); }
  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener(APP_RESUMED, this.retryAfterResume);
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Falha ao desenhar o painel; recuperando a tela.", error, info.componentStack);
    if (this.retried) return;
    this.retried = true;
    this.timer = setTimeout(() => { this.timer = undefined; this.setState({ failed: false }); }, 1200);
  }
  private retryAfterResume = () => {
    if (!this.state.failed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-recovery-screen" role="status" aria-live="polite">
        <section>
          <h1>Recuperando o painel</h1>
          <p>Seu acesso continua salvo. Se a tela não voltar, toque abaixo para abrir novamente.</p>
          <button type="button" onClick={() => window.location.reload()}>Abrir painel novamente</button>
        </section>
      </main>
    );
  }
}
