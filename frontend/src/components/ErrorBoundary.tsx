import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Shown instead of the crashed subtree. */
  title?: string;
  description?: string;
  compact?: boolean;
  onReset?: () => void;
};

type State = {
  error: Error | null;
};

/**
 * Catches render/effect errors so a single failing widget (e.g. a browser that
 * blocks WebGL for the map) can never blank the entire dashboard.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Flood Spaces] UI error:", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const {
      title = "This section could not load",
      description = "Something interrupted this panel. The rest of the dashboard is unaffected.",
      compact = false
    } = this.props;

    return (
      <div className={`panel-boundary ${compact ? "compact" : ""}`} role="alert">
        <strong>{title}</strong>
        <p>{description}</p>
        <code>{error.message}</code>
        <div className="panel-boundary-actions">
          <button className="ghost-btn" onClick={this.reset}>
            Try again
          </button>
          <button className="ghost-btn" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
