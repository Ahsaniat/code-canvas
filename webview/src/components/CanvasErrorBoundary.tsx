import React from 'react';
import * as log from '../log';

interface Props {
    children: React.ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Keeps one bad node or edge from blanking the whole canvas.
 *
 * The graph is rebuilt from data on every projection, so "Try again" simply
 * clears the error and lets the next render attempt the subtree again.
 */
export class CanvasErrorBoundary extends React.Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        log.error('canvas render failed:', error, info.componentStack);
    }

    render(): React.ReactNode {
        if (this.state.error) {
            return (
                <div className="canvas-error" role="alert">
                    <div className="canvas-error-title">Canvas render failed</div>
                    <div className="canvas-error-detail">{this.state.error.message}</div>
                    <button onClick={() => this.setState({ error: null })}>Try again</button>
                </div>
            );
        }
        return this.props.children;
    }
}
