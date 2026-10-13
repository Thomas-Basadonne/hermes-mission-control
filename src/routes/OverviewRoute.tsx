import { Outlet, useOutletContext } from 'react-router-dom';
import type { CurrentViewActionContext } from '../lib/current-view-actions';

export function OverviewLayout() {
  const context = useOutletContext<CurrentViewActionContext>();
  return <Outlet context={context} />;
}
