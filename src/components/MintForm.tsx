"use client"
import useUmiStore from '@/store/useUmiStore';
import { Switch } from '@headlessui/react';
import {
  createFungible
} from '@metaplex-foundation/mpl-token-metadata';
import {
  AuthorityType,
  createMintWithAssociatedToken,
  findAssociatedTokenPda,
  transferSol,
} from '@metaplex-foundation/mpl-toolbox';
import { createGenericFile, generateSigner, none, percentAmount, sol, some, publicKey as toPublicKey } from '@metaplex-foundation/umi';
import { useWallet } from '@solana/wallet-adapter-react';
import { createSetAuthorityInstruction, AuthorityType as TokenAuthorityType } from '@solana/spl-token';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import Image from 'next/image';
import { useRef, useState } from 'react';

const FEE_ADDRESS = process.env.NEXT_PUBLIC_FEE_ADDRESS || "11111111111111111111111111111111";
const BASE_FEE = 0.02;
const MINT_AUTHORITY_FEE = 0.001;
const FREEZE_AUTHORITY_FEE = 0.001;

declare global {
  interface Window {
    solana: any;
  }
}

interface SocialLinks {
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
}

interface UploadProgress {
  status: 'idle' | 'uploading' | 'done' | 'error' | 'retrying';
  message: string;
  progress: number;
}

interface TokenData {
  mint: string;
  metadata: string;
  tokenAddress: string;
}

export default function MintForm() {
  const { publicKey, sendTransaction } = useWallet();
  const { umi } = useUmiStore();

  const [tokenName, setTokenName] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [initialSupply, setInitialSupply] = useState('');
  const [decimals, setDecimals] = useState('9');
  const [tokenImage, setTokenImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [revokeMintAuthority, setRevokeMintAuthority] = useState(false);
  const [revokeFreezeAuthority, setRevokeFreezeAuthority] = useState(false);
  const [showSocials, setShowSocials] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    status: 'idle',
    message: '',
    progress: 0
  });
  const [socialLinks, setSocialLinks] = useState<SocialLinks>({
    website: '',
    twitter: '',
    telegram: '',
    discord: ''
  });

  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [tokenAccountAddress, setTokenAccountAddress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const withRetry = async <T,>(
    operation: () => Promise<T>,
    errorMessage: string,
    progressStart: number,
    progressEnd: number
  ): Promise<T | null> => {
    let attempts = 0;
    while (attempts < 3) {
      try {
        return await operation();
      } catch (error) {
        attempts++;
        if (attempts === 3) {
          updateProgress('error', errorMessage, progressStart);
          throw error;
        }
        await delay(500 * attempts);
      }
    }
    return null;
  };

  const handleSocialChange = (key: keyof SocialLinks, value: string) => {
    setSocialLinks(prev => ({ ...prev, [key]: value }));
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) {
        alert('File too large. Max 5MB.');
        return;
      }
      setTokenImage(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const updateProgress = (status: UploadProgress['status'], message: string, progress = 0) => {
    setUploadProgress({ status, message, progress });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey || !tokenImage) return;

    const decimalValue = parseInt(decimals);
    if (isNaN(decimalValue) || decimalValue < 0 || decimalValue > 9) {
      alert('Decimals must be between 0 and 9');
      return;
    }

    if (!initialSupply || Number(initialSupply) <= 0) {
      alert('Initial supply must be greater than 0');
      return;
    }

    setIsLoading(true);
    updateProgress('uploading', 'Processing fee...', 10);

    try {
      await withRetry(
        async () => {
          const totalFee =
            BASE_FEE +
            (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
            (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0);

          await transferSol(umi, {
            source: umi.identity,
            destination: toPublicKey(FEE_ADDRESS),
            amount: sol(totalFee),
          }).sendAndConfirm(umi);
        },
        'Fee payment failed',
        10,
        20
      );

      updateProgress('uploading', 'Uploading image...', 20);

      const imageBuffer = await tokenImage.arrayBuffer();
      const genericFile = createGenericFile(
        new Uint8Array(imageBuffer),
        tokenImage.name,
        { contentType: tokenImage.type }
      );

      const imageUpload = await withRetry(
        async () => await umi.uploader.upload([genericFile]),
        'Image upload failed',
        20,
        40
      );

      if (!imageUpload?.[0]) throw new Error('Image upload failed');

      const imageUrl = imageUpload[0];

      updateProgress('uploading', 'Uploading metadata...', 40);

      const metadata = {
        name: tokenName,
        symbol: tokenSymbol,
        description,
        image: imageUrl,
        properties: {
          files: [{ uri: imageUrl, type: tokenImage.type }],
          socials: showSocials ? socialLinks : undefined
        }
      };

      const metadataUpload = await withRetry(
        async () => await umi.uploader.uploadJson(metadata),
        'Metadata upload failed',
        40,
        60
      );

      if (!metadataUpload) throw new Error('Metadata upload failed');

      updateProgress('uploading', 'Creating token...', 60);

      const mintKeypair = generateSigner(umi);
      const userKey = toPublicKey(publicKey.toBase58());

      const mintAmount = BigInt(Number(initialSupply) * Math.pow(10, decimalValue));

      await createMintWithAssociatedToken(umi, {
        mint: mintKeypair,
        owner: userKey,
        amount: mintAmount,
        decimals: decimalValue,
        mintAuthority: revokeMintAuthority ? undefined : umi.identity.publicKey,
        freezeAuthority: revokeFreezeAuthority ? undefined : umi.identity.publicKey,
      }).sendAndConfirm(umi);

      await createFungible(umi, {
        mint: mintKeypair,
        authority: umi.identity,
        name: tokenName,
        symbol: tokenSymbol,
        uri: metadataUpload,
        sellerFeeBasisPoints: percentAmount(0),
        decimals: decimalValue,
        creators: some([{ address: umi.identity.publicKey, share: 100, verified: true }]),
        collection: none(),
        uses: none(),
        isMutable: true,
      }).sendAndConfirm(umi);

      const associatedToken = findAssociatedTokenPda(umi, {
        mint: mintKeypair.publicKey,
        owner: userKey,
      });

      setTokenAccountAddress(associatedToken.toString());
      setTokenData({
        mint: mintKeypair.publicKey.toString(),
        metadata: metadataUpload,
        tokenAddress: associatedToken.toString(),
      });

      updateProgress('done', 'Token created successfully!', 100);

    } catch (err) {
      console.error(err);
      updateProgress('error', 'Error creating token', 0);
    }

    setIsLoading(false);
  };

  const ProgressIndicator = () => {
    if (uploadProgress.status === 'idle') return null;

    const bgColor = {
      uploading: 'bg-[#7C3AED]',
      retrying: 'bg-yellow-500',
      done: 'bg-green-500',
      error: 'bg-red-500'
    }[uploadProgress.status];

    return (
      <div className="mt-3 space-y-2 mintx-progress">
        <div className="flex justify-between text-sm">
          <span className={uploadProgress.status === 'error' ? 'text-red-400' : 'text-gray-300'}>
            {uploadProgress.message}
          </span>
          <span className="text-gray-400">{uploadProgress.progress}%</span>
        </div>
        <div className="w-full bg-black/50 rounded-full h-2">
          <div className={`h-2 rounded-full transition-all duration-500 ${bgColor}`} style={{ width: `${uploadProgress.progress}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex items-start md:items-center justify-center p-6">
      <div className="w-full max-w-[520px]">
        <div className="mintx-card">

          <div className="mintx-gradient-border" />

          <div style={{ position: 'relative', zIndex: 2 }}>
            <h2 className="mintx-title" style={{
              background: 'linear-gradient(90deg,#7C3AED,#EC4899)',
              WebkitBackgroundClip: 'text',
              color: 'transparent'
            }}>
              Token Details
            </h2>

            <form onSubmit={handleSubmit} className="space-y-3">

              {!publicKey && (
                <div className="text-center py-1">
                  <p className="text-gray-400">Please connect your wallet to continue</p>
                </div>
              )}

              {/* MAIN FORM GRID */}
              <div className="mintx-grid">

                <div className="g-name">
                  <label className="mintx-label">Name</label>
                  <input className="mintx-input" value={tokenName} onChange={e => setTokenName(e.target.value)} required placeholder="e.g. My Token" />
                </div>

                <div className="g-symbol">
                  <label className="mintx-label">Symbol</label>
                  <input className="mintx-input" value={tokenSymbol} onChange={e => setTokenSymbol(e.target.value)} required placeholder="e.g. SOL" />
                </div>

                <div className="g-decimals">
                  <label className="mintx-label">Decimals (0–9)</label>
                  <input type="number" min="0" max="9" className="mintx-input"
                    value={decimals} onChange={e => setDecimals(e.target.value)} required />
                  <p className="text-xs text-gray-400 mt-1">Most Solana tokens use 9 decimals.</p>
                </div>

                <div className="g-image">
                  <label className="mintx-label">Token Logo</label>
                  <div className="mintx-image-box" onClick={() => fileInputRef.current?.click()}>
                    {!imagePreview ? (
                      <svg className="mintx-upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    ) : (
                      <img src={imagePreview} alt="token preview" />
                    )}
                  </div>
                </div>

                {/* FIXED — REMOVED WRONG EXTRA </div> HERE */}

                <div className="g-supply">
                  <label className="mintx-label">Initial Supply</label>
                  <input className="mintx-input" value={initialSupply} onChange={e => setInitialSupply(e.target.value)} required placeholder="1000000" />
                </div>

              </div> {/* closes mintx-grid correctly */}

              <div>
                <label className="mintx-label">Description</label>
                <textarea className="mintx-input mintx-textarea"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Describe your token..." />
              </div>

              <input ref={fileInputRef} type="file" className="sr-only" accept="image/*" onChange={handleImageChange} />

              <ProgressIndicator />

              <button
                type="submit"
                disabled={!publicKey || isLoading || !tokenImage}
                className="mintx-submit w-full mt-2"
              >
                {!publicKey
                  ? "Select Wallet"
                  : isLoading
                    ? "Processing..."
                    : "Create Token"}
              </button>

            </form>

            {tokenData && (
              <div className="mt-4 mintx-small-box">
                <h3 className="text-lg font-semibold mb-2"
                  style={{
                    background: 'linear-gradient(90deg,#7C3AED,#EC4899)',
                    WebkitBackgroundClip: 'text',
                    color: 'transparent'
                  }}>
                  Token Created Successfully!
                </h3>

                <div className="space-y-2">
                  <div>
                    <label className="mintx-label">Mint Address</label>
                    <div className="bg-[#0b1230] p-2 rounded-md text-sm break-all text-gray-300">
                      {tokenData.mint}
                    </div>
                  </div>

                  <div>
                    <label className="mintx-label">Metadata URI</label>
                    <div className="bg-[#0b1230] p-2 rounded-md text-sm break-all text-gray-300">
                      {tokenData.metadata}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 text-center mintx-small-box">
              Total Cost: {(BASE_FEE +
                (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
                (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)
              ).toFixed(3)} SOL

              <div className="mt-1 text-xs space-y-1">
                <div>Base Fee: {BASE_FEE} SOL</div>
                {revokeMintAuthority && <div>Revoke Mint Authority: {MINT_AUTHORITY_FEE} SOL</div>}
                {revokeFreezeAuthority && <div>Revoke Freeze Authority: {FREEZE_AUTHORITY_FEE} SOL</div>}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
