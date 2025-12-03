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
  setAuthority,
  transferSol,
} from '@metaplex-foundation/mpl-toolbox';
import { createGenericFile, generateSigner, none, percentAmount, sol, some, publicKey as toPublicKey, signTransaction } from '@metaplex-foundation/umi';
import { useWallet } from '@solana/wallet-adapter-react';
import { createSetAuthorityInstruction, AuthorityType as TokenAuthorityType } from '@solana/spl-token';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, clusterApiUrl } from '@solana/web3.js';
import { fromWeb3JsTransaction, toWeb3JsInstruction, toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import Image from 'next/image';
import { useRef, useState } from 'react';
// Environment variables
const FEE_ADDRESS = process.env.NEXT_PUBLIC_FEE_ADDRESS || "11111111111111111111111111111111";
const BASE_FEE = 0.02; // Base fee for token creation
const MINT_AUTHORITY_FEE = 0.001; // Fee for revoking mint authority
const FREEZE_AUTHORITY_FEE = 0.001; // Fee for revoking freeze authority

// Add type declaration for window.solana
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
  retryCount?: number;
  error?: string;
}

// Add new interface for token data
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
  const [decimals, setDecimals] = useState('9'); // Default to 9 decimals
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
  const [retryAttempts, setRetryAttempts] = useState(0);
  const MAX_RETRIES = 3;
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [tokenAccountAddress, setTokenAccountAddress] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Add retry delay utility
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Add retry wrapper function
  const withRetry = async <T,>(
    operation: () => Promise<T>,
    errorMessage: string,
    progressStart: number,
    progressEnd: number
  ): Promise<T | null> => {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
      try {
        const result = await operation();
        return result;
      } catch (error) {
        attempts++;
        console.error(`Attempt ${attempts} failed:`, error);

        if (attempts === MAX_RETRIES) {
          updateProgress('error', `${errorMessage} (${attempts} failed attempts)`, 0);
          throw error;
        }

        const backoffTime = Math.min(1000 * Math.pow(2, attempts), 10000);
        updateProgress(
          'retrying',
          `${errorMessage} - Retrying in ${backoffTime / 1000}s (Attempt ${attempts + 1}/${MAX_RETRIES})`,
          progressStart
        );
        await delay(backoffTime);
      }
    }
    return null;
  };

  const handleSocialChange = (key: keyof SocialLinks, value: string) => {
    setSocialLinks(prev => ({ ...prev, [key]: value }));
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        alert('File size too large. Please choose an image under 5MB.');
        return;
      }
      setTokenImage(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const updateProgress = (status: UploadProgress['status'], message: string, progress: number = 0) => {
    setUploadProgress({ status, message, progress });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey || !tokenImage) return;

    // Validate decimals
    const decimalValue = parseInt(decimals);
    if (isNaN(decimalValue) || decimalValue < 0 || decimalValue > 9) {
      alert('Decimals must be between 0 and 9');
      return;
    }

    // Validate initial supply
    if (!initialSupply || Number(initialSupply) <= 0) {
      alert('Initial supply must be greater than 0');
      return;
    }

    setIsLoading(true);
    setRetryAttempts(0);
    updateProgress('idle', 'Initializing upload...', 0);

    try {
      // Send fee payment first
      updateProgress('uploading', 'Processing fee payment...', 10);
      await withRetry(
        async () => {
          const totalFee = BASE_FEE +
            (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
            (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0);

          await transferSol(umi, {
            source: umi.identity,
            destination: toPublicKey(FEE_ADDRESS),
            amount: sol(totalFee),
          }).sendAndConfirm(umi);
        },
        'Error processing fee payment',
        10,
        20
      );

      // Upload image using Umi's Irys uploader
      updateProgress('uploading', 'Uploading image...', 20);

      const imageBuffer = await tokenImage.arrayBuffer();
      const genericFile = createGenericFile(
        new Uint8Array(imageBuffer),
        tokenImage.name,
        { contentType: tokenImage.type }
      );

      const imageUpload = await withRetry(
        async () => await umi.uploader.upload([genericFile]),
        'Error uploading image',
        20,
        40
      );

      if (!imageUpload || !imageUpload[0]) {
        throw new Error('Failed to upload image after multiple attempts');
      }

      const imageUrl = imageUpload[0];
      updateProgress('uploading', 'Creating metadata...', 40);

      // Create and upload metadata using Umi
      const metadata = {
        name: tokenName,
        symbol: tokenSymbol,
        description: description,
        image: imageUrl,
        properties: {
          files: [
            {
              uri: imageUrl,
              type: tokenImage.type,
            },
          ],
          socials: showSocials ? socialLinks : undefined
        },
      };

      const metadataUpload = await withRetry(
        async () => await umi.uploader.uploadJson(metadata),
        'Error uploading metadata',
        40,
        60
      );

      if (!metadataUpload) {
        throw new Error('Failed to upload metadata after multiple attempts');
      }

      updateProgress('uploading', 'Creating token...', 60);

      // Create token mint
      const mintKeypair = generateSigner(umi);
      const userPublicKey = toPublicKey(publicKey.toBase58());

      await withRetry(
        async () => {
          // First create mint with associated token account and initial supply
          updateProgress('uploading', 'Creating mint and token account...', 70);
          const mintAmount = BigInt(Number(initialSupply) * Math.pow(10, decimalValue));

          // Create mint and token account with proper authorities
          await createMintWithAssociatedToken(umi, {
            mint: mintKeypair,
            owner: userPublicKey,
            amount: mintAmount,
            decimals: decimalValue,
            mintAuthority: revokeMintAuthority ? undefined : umi.identity.publicKey,
            freezeAuthority: revokeFreezeAuthority ? undefined : umi.identity.publicKey,
          }).sendAndConfirm(umi);

          // Then create the fungible token metadata
          updateProgress('uploading', 'Creating token metadata...', 80);
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

          // Get the token account address
          const tokenAccount = findAssociatedTokenPda(umi, {
            mint: mintKeypair.publicKey,
            owner: userPublicKey,
          });
          setTokenAccountAddress(tokenAccount.toString());

          // Set the token data for display
          setTokenData({
            mint: mintKeypair.publicKey.toString(),
            metadata: metadataUpload,
            tokenAddress: tokenAccount.toString(),
          });
        },
        'Error creating token',
        60,
        100
      );

      if (revokeFreezeAuthority || revokeMintAuthority) {
        try {
          const endpoint = process.env.NEXT_PUBLIC_RPC_URL || "";

          const connection = new Connection(endpoint);
          const messageV0 = new TransactionMessage({
            payerKey: new PublicKey(umi.identity.publicKey),
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            instructions: [
              ...(revokeFreezeAuthority ? [
                createSetAuthorityInstruction(
                  new PublicKey(mintKeypair.publicKey),
                  new PublicKey(umi.identity.publicKey),
                  TokenAuthorityType.FreezeAccount,
                  null
                )
              ] : []),
              ...(revokeMintAuthority ? [
                createSetAuthorityInstruction(
                  new PublicKey(mintKeypair.publicKey),
                  new PublicKey(umi.identity.publicKey),
                  TokenAuthorityType.MintTokens,
                  null
                )
              ] : [])
            ],
          }).compileToV0Message();

          const tx = new VersionedTransaction(messageV0);

          // Sign with the wallet adapter
          if (sendTransaction) {
            const signature = await sendTransaction(tx, connection, {
              skipPreflight: false,
              maxRetries: 3
            });
            await connection.confirmTransaction(signature, 'confirmed');
            console.log('Authorities revoked successfully');
          }
        } catch (error) {
          console.error('Error revoking authorities:', error);
          throw error;
        }
      }

      updateProgress('done', 'Token created and minted successfully!', 100);
    } catch (error: unknown) {
      console.error('Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      updateProgress('error', `Error: ${errorMessage}`, 0);
    } finally {
      setIsLoading(false);
    }
  };

  // Update ProgressIndicator styling
  const ProgressIndicator = () => {
    if (uploadProgress.status === 'idle') return null;

    const bgColor = {
      uploading: 'bg-[#7C3AED]',
      retrying: 'bg-yellow-500',
      done: 'bg-green-500',
      error: 'bg-red-500'
    }[uploadProgress.status];

    return (
      <div className="mt-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className={`${uploadProgress.status === 'error' ? 'text-red-400' : 'text-gray-300'}`}>
            {uploadProgress.message}
          </span>
          <span className="text-gray-400">{uploadProgress.progress}%</span>
        </div>
        <div className="w-full bg-black/50 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all duration-500 ${bgColor}`}
            style={{ width: `${uploadProgress.progress}%` }}
          />
        </div>
        {uploadProgress.status === 'error' && (
          <button
            onClick={(e) => {
              e.preventDefault();
              handleSubmit(e as any);
            }}
            className="mt-2 text-sm text-[#7C3AED] hover:text-[#EC4899] focus:outline-none transition-colors"
          >
            Try Again
          </button>
        )}
      </div>
    );
  };

  const handleHomeClick = (e: React.MouseEvent) => {
    e.preventDefault();
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex items-start md:items-center justify-center p-6">
      <div className="w-full max-w-[480px]">
        {/* Card */}
        <div className="relative rounded-[18px] p-5 border border-[rgba(255,255,255,0.04)] shadow-[0_12px_40px_rgba(0,0,0,0.6)] bg-[#0b0c15] overflow-visible mintx-card">
          {/* neon stroke */}
          <div className="absolute inset-0 rounded-[18px] pointer-events-none mintx-neon" />
          <div className="relative z-10">
            <h2 className="text-2xl font-semibold mb-4 bg-gradient-to-r from-[#7C3AED] to-[#EC4899] bg-clip-text text-transparent">
              Token Details
            </h2>

            <form onSubmit={handleSubmit} className="space-y-4">
              {!publicKey && (
                <div className="text-center py-2 mb-2">
                  <p className="text-gray-400">Please connect your wallet to continue</p>
                </div>
              )}

              {/* FIXED 2-COLUMN GRID (mobile + desktop) */}
              <div className="grid grid-cols-2 gap-3">
                {/* Name */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Name</label>
                  <input
                    type="text"
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder="e.g. My Amazing Token"
                    className="mintx-input"
                    required
                  />
                </div>

                {/* Symbol */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Symbol</label>
                  <input
                    type="text"
                    value={tokenSymbol}
                    onChange={(e) => setTokenSymbol(e.target.value)}
                    placeholder="e.g. MAT"
                    className="mintx-input"
                    required
                  />
                </div>

                {/* Decimals */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Decimals</label>
                  <input
                    type="number"
                    min="0"
                    max="9"
                    value={decimals}
                    onChange={(e) => setDecimals(e.target.value)}
                    className="mintx-input"
                    placeholder="6"
                    required
                  />
                </div>

                {/* Image box */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Image</label>

                  <div
                    className="mintx-image-box"
                    onClick={() => fileInputRef.current?.click()}
                    role="button"
                    aria-label="Upload token image"
                  >
                    {!imagePreview ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                      </svg>
                    ) : (
                      <img src={imagePreview} alt="preview" className="w-full h-full object-cover rounded-md" />
                    )}
                  </div>
                </div>

                {/* Supply (placed left column under Decimals) */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Supply</label>
                  <input
                    type="text"
                    value={initialSupply}
                    onChange={(e) => setInitialSupply(e.target.value)}
                    placeholder="e.g. 1000000"
                    className="mintx-input"
                    required
                  />
                </div>

                {/* empty cell to preserve exact grid */}
                <div aria-hidden="true"></div>
              </div>

              {/* Description full-width */}
              <div>
                <label className="block text-sm text-gray-200 mb-2">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Describe your token and its purpose"
                  className="mintx-input mintx-textarea"
                />
              </div>

              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                onChange={handleImageChange}
                accept="image/*"
              />

              {/* Toggles area (two-column fixed) */}
              <div className="grid grid-cols-2 gap-3">
                <div className="mintx-toggle-card">
                  <div className="flex items-start justify-between w-full">
                    <div className="pr-2">
                      <h3 className="text-sm font-medium text-white">Revoke Freeze <span className="text-xs text-gray-400">(required)</span></h3>
                      <p className="text-xs text-gray-400 mt-1">Revoke Freeze allows you to create a liquidity pool</p>
                    </div>
                    <div className="flex flex-col items-end">
                      <div className="mintx-switch-wrap">
                        <Switch
                          checked={revokeFreezeAuthority}
                          onChange={setRevokeFreezeAuthority}
                          className={`${revokeFreezeAuthority ? 'mintx-switch-active' : 'mintx-switch'}`}
                        >
                          <span className={`${revokeFreezeAuthority ? 'mintx-switch-handle translate-x-[22px]' : 'mintx-switch-handle'}`} />
                        </Switch>
                      </div>
                      <div className="text-xs text-gray-400 mt-2">(0.1 SOL)</div>
                    </div>
                  </div>
                </div>

                <div className="mintx-toggle-card">
                  <div className="flex items-start justify-between w-full">
                    <div className="pr-2">
                      <h3 className="text-sm font-medium text-white">Revoke Mint</h3>
                      <p className="text-xs text-gray-400 mt-1">Mint Authority allows you to increase tokens supply</p>
                    </div>
                    <div className="flex flex-col items-end">
                      <div className="mintx-switch-wrap">
                        <Switch
                          checked={revokeMintAuthority}
                          onChange={setRevokeMintAuthority}
                          className={`${revokeMintAuthority ? 'mintx-switch-active' : 'mintx-switch'}`}
                        >
                          <span className={`${revokeMintAuthority ? 'mintx-switch-handle translate-x-[22px]' : 'mintx-switch-handle'}`} />
                        </Switch>
                      </div>
                      <div className="text-xs text-gray-400 mt-2">(0.1 SOL)</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Show socials toggle */}
              <div className="mintx-toggle-card flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-white">Add Social Links</h3>
                  <p className="text-xs text-gray-400">Include social media links for your token</p>
                </div>
                <Switch
                  checked={showSocials}
                  onChange={setShowSocials}
                  className={`${showSocials ? 'mintx-switch-active' : 'mintx-switch'}`}
                >
                  <span className={`${showSocials ? 'mintx-switch-handle translate-x-[22px]' : 'mintx-switch-handle'}`} />
                </Switch>
              </div>

              {showSocials && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-200 mb-2">Website</label>
                    <input type="url" value={socialLinks.website} onChange={(e) => handleSocialChange('website', e.target.value)} className="mintx-input" placeholder="https://your-website.com" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-200 mb-2">Twitter</label>
                    <input type="url" value={socialLinks.twitter} onChange={(e) => handleSocialChange('twitter', e.target.value)} className="mintx-input" placeholder="https://twitter.com/username" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-200 mb-2">Telegram</label>
                    <input type="url" value={socialLinks.telegram} onChange={(e) => handleSocialChange('telegram', e.target.value)} className="mintx-input" placeholder="https://t.me/username" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-200 mb-2">Discord</label>
                    <input type="url" value={socialLinks.discord} onChange={(e) => handleSocialChange('discord', e.target.value)} className="mintx-input" placeholder="https://discord.gg/invite" />
                  </div>
                </div>
              )}

              <ProgressIndicator />

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={!publicKey || isLoading || !tokenImage}
                  className={`w-full flex justify-center py-3 px-4 rounded-lg text-sm font-medium text-white mintx-submit ${!publicKey ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {!publicKey ? (
                    'Select Wallet'
                  ) : isLoading ? (
                    <span className="flex items-center">
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {uploadProgress.message || 'Processing...'}
                    </span>
                  ) : (
                    'Create Token'
                  )}
                </button>
              </div>
            </form>

            {/* token created box */}
            {tokenData && (
              <div className="mt-4 p-3 rounded-lg bg-[#07112b] border border-[#17243b]">
                <h3 className="text-lg font-semibold mb-2 bg-gradient-to-r from-[#7C3AED] to-[#EC4899] bg-clip-text text-transparent">
                  Token Created Successfully!
                </h3>
                <div className="space-y-2">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Mint Address</label>
                    <div className="text-sm text-gray-400 break-all bg-[#0b1230] p-2 rounded-md">{tokenData.mint}</div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Metadata URI</label>
                    <div className="text-sm text-gray-400 break-all bg-[#0b1230] p-2 rounded-md">{tokenData.metadata}</div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 text-center text-sm text-gray-400 p-2 rounded-lg bg-[#07112b] border border-[#17243b]">
              Total Cost: {(BASE_FEE + (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) + (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)).toFixed(3)} SOL
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
