import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
    /** What the island is, for the console: "zone sidebar". */
    name: string;
    /** Shown in place of the island once it has failed; `retry` remounts it. */
    fallback: (retry: () => void) => ReactNode;
    /** Clean up after the failure, e.g. layers the island left on the map. */
    onError?: (error: unknown) => void;
    /** Clear the state that broke the island, before it remounts. */
    onRetry?: () => void;
    children: ReactNode;
}

/**
 * Each map island is its own React root (Astro), and an uncaught error
 * unmounts the whole root: without this the island just disappears.
 */
export class IslandErrorBoundary extends Component<Props, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown, info: ErrorInfo) {
        console.error(
            `[searchlight] The ${this.props.name} failed`,
            error,
            info.componentStack,
        );
        this.props.onError?.(error);
    }

    retry = () => {
        this.props.onRetry?.();
        this.setState({ failed: false });
    };

    render() {
        return this.state.failed
            ? this.props.fallback(this.retry)
            : this.props.children;
    }
}
