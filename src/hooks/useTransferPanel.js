import { useLayoutEffect, useState } from "preact/hooks";
import { useRouter } from "./useRouter.jsx";

export function useTransferPanel(transfer, mobile) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (transfer.batch && !mobile) setExpanded(true);
  }, [transfer.batch]);
  useLayoutEffect(() => {
    // A desktop window that becomes a mobile page must also get a Back entry.
    if (mobile && expanded) {
      if (!router.state.transfersFrom)
        router.navigate(router.route.href, {
          push: true,
          state: { ...router.state, transfersFrom: router.route.href },
        });
      setExpanded(false);
    }
  }, [mobile, expanded]);
  return {
    open: expanded || !!router.state.transfersFrom,
    onOpen: () => {
      if (mobile)
        router.navigate(router.route.href, {
          push: true,
          state: { ...router.state, transfersFrom: router.route.href },
        });
      else setExpanded(true);
    },
    onClose: () => {
      setExpanded(false);
      if (router.state.transfersFrom)
        router.close("transfersFrom", router.route.href);
    },
  };
}
