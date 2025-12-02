"use client";

import {
  WalletProvider
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import React, { FC, useMemo } from "react";

import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

type Props = {
  children?: React.ReactNode;
};

export const WalletAdapterProvider: FC<Props> = ({ children }) => {

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),

      // MOST IMPORTANT FOR MOBILE:
      // The wallet modal will automatically show deep links
      // for Phantom, Solflare, Trust Wallet, Coinbase, etc.
    ],
    []
  );

  return (
    <WalletProvider wallets={wallets} autoConnect>
      <WalletModalProvider>{children}</WalletModalProvider>
    </WalletProvider>
  );
};
