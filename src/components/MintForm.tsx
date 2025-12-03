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
    // outer wrapper: center the card and give page background similar to Orion
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex items-start md:items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Card */}
        <div className="relative rounded-2xl p-6 border border-[rgba(255,255,255,0.04)] shadow-[0_12px_40px_rgba(0,0,0,0.6)] bg-[#0b0c15] overflow-hidden"
             style={{ boxShadow: '0 12px 40px rgba(7,8,18,0.7)'}}>
          {/* glow border (thin rounded stroke) */}
          <div className="absolute -inset-0.5 rounded-2xl pointer-events-none"
               style={{
                 background: 'linear-gradient(135deg, rgba(124,58,237,0.14), rgba(236,72,153,0.06))',
                 mixBlendMode: 'screen',
                 zIndex: 0
               }} />

          <div style={{ position: 'relative', zIndex: 10 }}>
            <h2 className="text-2xl font-semibold mb-6 bg-gradient-to-r from-[#7C3AED] to-[#EC4899] bg-clip-text text-transparent">
              Token Details
            </h2>

            <form onSubmit={handleSubmit} className="space-y-6">
              {!publicKey && (
                <div className="text-center py-3 mb-2">
                  <p className="text-gray-400">Please connect your wallet to continue</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Name */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Name</label>
                  <input
                    type="text"
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                    placeholder="e.g. My Amazing Token"
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
                    className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                    placeholder="e.g. MAT"
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
                    className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                    placeholder="6"
                    required
                  />
                </div>

                {/* Image upload box */}
                <div>
                  <label className="block text-sm text-gray-200 mb-2">Image</label>
                  <div
                    className="w-full h-20 rounded-lg flex items-center justify-center bg-[#0d1130] border border-[#18203a] cursor-pointer"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {imagePreview ? (
                      <img src={imagePreview} alt="logo preview" className="w-16 h-16 rounded-md object-cover" />
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                      </svg>
                    )}
                  </div>
                </div>

                {/* Supply (spans left) */}
                <div className="sm:col-span-1">
                  <label className="block text-sm text-gray-200 mb-2">Supply</label>
                  <input
                    type="text"
                    value={initialSupply}
                    onChange={(e) => setInitialSupply(e.target.value)}
                    className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                    placeholder="e.g. 1000000"
                    required
                  />
                </div>

                {/* Description (full width on small screens) */}
                <div className="sm:col-span-2">
                  <label className="block text-sm text-gray-200 mb-2">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                    placeholder="Describe your token and its purpose"
                  />
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                onChange={handleImageChange}
                accept="image/*"
              />

              {/* Toggles area */}
              <div className="grid grid-cols-1 gap-3">
                <div className="flex items-start justify-between p-3 rounded-lg bg-[#07112b] border border-[#17243b]">
                  <div className="flex-1 pr-3">
                    <h3 className="text-sm font-medium text-white">Revoke Freeze <span className="text-xs text-gray-400">(required)</span></h3>
                    <p className="text-xs text-gray-400 mt-1">Revoke Freeze allows you to create a liquidity pool</p>
                  </div>
                  <div className="flex flex-col items-end">
                    <Switch
                      checked={revokeFreezeAuthority}
                      onChange={setRevokeFreezeAuthority}
                      className={`${revokeFreezeAuthority ? 'bg-gradient-to-r from-[#7C3AED] to-[#EC4899]' : 'bg-[#1b2130]'}
                        relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none`}
                    >
                      <span className={`${revokeFreezeAuthority ? 'translate-x-5' : 'translate-x-1'}
                        inline-block h-4 w-4 transform bg-white rounded-full transition-transform`} />
                    </Switch>
                    <div className="text-xs text-gray-400 mt-2">(0.1 SOL)</div>
                  </div>
                </div>

                <div className="flex items-start justify-between p-3 rounded-lg bg-[#07112b] border border-[#17243b]">
                  <div className="flex-1 pr-3">
                    <h3 className="text-sm font-medium text-white">Revoke Mint</h3>
                    <p className="text-xs text-gray-400 mt-1">Mint Authority allows you to increase tokens supply</p>
                  </div>
                  <div className="flex flex-col items-end">
                    <Switch
                      checked={revokeMintAuthority}
                      onChange={setRevokeMintAuthority}
                      className={`${revokeMintAuthority ? 'bg-gradient-to-r from-[#7C3AED] to-[#EC4899]' : 'bg-[#1b2130]'}
                        relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none`}
                    >
                      <span className={`${revokeMintAuthority ? 'translate-x-5' : 'translate-x-1'}
                        inline-block h-4 w-4 transform bg-white rounded-full transition-transform`} />
                    </Switch>
                    <div className="text-xs text-gray-400 mt-2">(0.1 SOL)</div>
                  </div>
                </div>

                {/* Add Social Links */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-[#07112b] border border-[#17243b]">
                  <div>
                    <h3 className="text-sm font-medium text-white">Add Social Links</h3>
                    <p className="text-xs text-gray-400">Include social media links for your token</p>
                  </div>
                  <Switch
                    checked={showSocials}
                    onChange={setShowSocials}
                    className={`${showSocials ? 'bg-gradient-to-r from-[#7C3AED] to-[#EC4899]' : 'bg-[#1b2130]'}
                      relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none`}
                  >
                    <span
                      className={`${showSocials ? 'translate-x-5' : 'translate-x-1'}
                        inline-block h-4 w-4 transform bg-white rounded-full transition-transform`}
                    />
                  </Switch>
                </div>
              </div>

              {showSocials && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-200 mb-2">Website</label>
                      <input
                        type="url"
                        value={socialLinks.website}
                        onChange={(e) => handleSocialChange('website', e.target.value)}
                        className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                        placeholder="https://your-website.com"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-200 mb-2">Twitter</label>
                      <input
                        type="url"
                        value={socialLinks.twitter}
                        onChange={(e) => handleSocialChange('twitter', e.target.value)}
                        className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                        placeholder="https://twitter.com/username"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-200 mb-2">Telegram</label>
                      <input
                        type="url"
                        value={socialLinks.telegram}
                        onChange={(e) => handleSocialChange('telegram', e.target.value)}
                        className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                        placeholder="https://t.me/username"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-200 mb-2">Discord</label>
                      <input
                        type="url"
                        value={socialLinks.discord}
                        onChange={(e) => handleSocialChange('discord', e.target.value)}
                        className="w-full px-3 py-3 bg-[#0b1230] border border-[#18203a] rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7C3AED]"
                        placeholder="https://discord.gg/invite"
                      />
                    </div>
                  </div>
                </div>
              )}

              <ProgressIndicator />

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={!publicKey || isLoading || !tokenImage}
                  className={`w-full flex justify-center py-3 px-4 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-[#7C3AED] to-[#EC4899] hover:brightness-105 transition disabled:opacity-50 disabled:cursor-not-allowed`}
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

            {/* created token box */}
            {tokenData && (
              <div className="mt-6 p-4 rounded-lg bg-[#07112b] border border-[#17243b]">
                <h3 className="text-lg font-semibold mb-3 bg-gradient-to-r from-[#7C3AED] to-[#EC4899] bg-clip-text text-transparent">
                  Token Created Successfully!
                </h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Mint Address</label>
                    <div className="text-sm text-gray-400 break-all bg-[#0b1230] p-3 rounded-md">
                      {tokenData.mint}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Metadata URI</label>
                    <div className="text-sm text-gray-400 break-all bg-[#0b1230] p-3 rounded-md">
                      {tokenData.metadata}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 text-center text-sm text-gray-400 p-3 rounded-lg bg-[#07112b] border border-[#17243b]">
              Total Cost: {(BASE_FEE + (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) + (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)).toFixed(3)} SOL
              <div className="mt-2 text-xs space-y-1">
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
