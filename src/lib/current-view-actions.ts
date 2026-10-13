import { useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';

export type CurrentViewActionContext = {
  registerCurrentViewRefresh: (id: string, refresh: () => Promise<unknown>) => () => void;
};

/** Register the view's existing refresh handler with the persistent shell. */
export function useRegisterCurrentViewRefresh(id: string, refresh: () => Promise<unknown>) {
  const context = useOutletContext<CurrentViewActionContext | null>();
  const registerCurrentViewRefresh = context?.registerCurrentViewRefresh;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(
    () => registerCurrentViewRefresh?.(id, () => refreshRef.current()),
    [id, registerCurrentViewRefresh],
  );
}
