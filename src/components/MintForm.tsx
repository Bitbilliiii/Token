"use client";
import useUmiStore from "@/store/useUmiStore";
import { Switch } from "@headlessui/react";
import { createFungible } from "@metaplex-foundation/mpl-token-metadata";
import {
  createMintWithAssociatedToken,
  findAssociatedTokenPda,
  transferSol,
} from "@metaplex-foundation/mpl-toolbox";
import {
  createGenericFile,
  generateSigner,
  none,
  percentAmount,
  sol,
  some,
  publicKey as toPublicKey,
} from "@metaplex-foundation/umi";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";

// FEES
const FEE_ADDRESS = process.env.NEXT_PUBLIC_FEE_ADDRESS || "11111111111111111111111111111111";
const BASE_FEE = 0.05;
const MINT_AUTHORITY_FEE = 0.0123;
const FREEZE_AUTHORITY_FEE = 0.0123;

interface SocialLinks {
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
}

interface UploadProgress {
  status: "idle" | "uploading" | "done" | "error" | "retrying";
  message: string;
  progress: number;
}

interface TokenData {
  mint: string;
  metadata: string;
  tokenAddress: string;
}

export default function MintForm() {
  const { publicKey } = useWallet();
  const { umi } = useUmiStore();

  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [initialSupply, setInitialSupply] = useState("");
  const [decimals, setDecimals] = useState("9");
  const [tokenImage, setTokenImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");

  const [description, setDescription] = useState("");

  const [revokeFreezeAuthority, setRevokeFreezeAuthority] = useState(false);
  const [revokeMintAuthority, setRevokeMintAuthority] = useState(false);
  const [showSocials, setShowSocials] = useState(false);

  const [socialLinks, setSocialLinks] = useState<SocialLinks>({
    website: "",
    twitter: "",
    telegram: "",
    discord: "",
  });

  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    status: "idle",
    message: "",
    progress: 0,
  });

  const [isLoading, setIsLoading] = useState(false);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);

  const leftColRef = useRef<HTMLDivElement>(null);
  const [imageBoxHeight, setImageBoxHeight] = useState<number>(220);

  // Dynamically match image box height to total left column height (Decimals + Supply area)
  useEffect(() => {
    if (leftColRef.current) {
      setImageBoxHeight(leftColRef.current.offsetHeight);
    }
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateProgress = (status: UploadProgress["status"], message: string, progress = 0) => {
    setUploadProgress({ status, message, progress });
  };

  const handleImageChange = (e: any) => {
    const file = e?.target?.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large (max 5MB)");
      return;
    }
    setTokenImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleSocialChange = (key: keyof SocialLinks, value: string) => {
    setSocialLinks((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (!publicKey) return alert("Connect wallet first");
    if (!tokenImage) return alert("Upload token logo");

    const decimalValue = Number(decimals);
    if (decimalValue < 0 || decimalValue > 9) return alert("Decimals must be 0–9");
    if (!initialSupply || Number(initialSupply) <= 0) return alert("Enter valid supply");

    setIsLoading(true);
    updateProgress("uploading", "Processing fee...", 10);

    try {
      // Fee transfer
      const totalFee = BASE_FEE +
        (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
        (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0);

      await transferSol(umi, {
        source: umi.identity,
        destination: toPublicKey(FEE_ADDRESS),
        amount: sol(totalFee),
      }).sendAndConfirm(umi);

      updateProgress("uploading", "Uploading image...", 20);

      const buffer = await tokenImage.arrayBuffer();
      const file = createGenericFile(new Uint8Array(buffer), tokenImage.name, {
        contentType: tokenImage.type,
      });

      const uploadedImg = await umi.uploader.upload([file]);
      const imageUrl = uploadedImg[0];

      updateProgress("uploading", "Uploading metadata...", 40);

      const metadata = {
        name: tokenName,
        symbol: tokenSymbol,
        description,
        image: imageUrl,
        properties: {
          files: [{ uri: imageUrl, type: tokenImage.type }],
          socials: showSocials ? socialLinks : undefined,
        },
      };

      const metadataUri = await umi.uploader.uploadJson(metadata);

      updateProgress("uploading", "Creating token...", 60);

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
        uri: metadataUri,
        sellerFeeBasisPoints: percentAmount(0),
        decimals: decimalValue,
        creators: some([{ address: umi.identity.publicKey, share: 100, verified: true }]),
      }).sendAndConfirm(umi);

      updateProgress("done", "Token created!", 100);
    } catch (err) {
      console.error(err);
      updateProgress("error", "Token creation failed", 0);
    }

    setIsLoading(false);
  };

  const ProgressIndicator = () => {
    if (uploadProgress.status === "idle") return null;
    const bg = uploadProgress.status === "done" ? "bg-green-500"
      : uploadProgress.status === "error" ? "bg-red-500"
        : "bg-[#7C3AED]";

    return (
      <div className="mt-3">
        <div className="flex justify-between text-sm text-gray-300 mb-1">
          <span>{uploadProgress.message}</span>
          <span>{uploadProgress.progress}%</span>
        </div>

        <div className="w-full bg-black/50 h-2 rounded-full">
          <div className={`h-2 rounded-full ${bg}`} style={{ width: `${uploadProgress.progress}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex justify-center p-6">
      <div className="w-full max-w-[620px]">
        <div className="mintx-card relative">

          {/* CARD BORDER EFFECT */}
          <div className="mintx-gradient-border" />

          <div className="relative z-10">
            <h2
              className="mintx-title"
              style={{
                background: "linear-gradient(90deg,#7C3AED,#EC4899)",
                WebkitBackgroundClip: "text",
                color: "transparent",
              }}
            >
              Token Details
            </h2>

            {/* EXACT 2-COLUMN LAYOUT ALWAYS */}
            <form onSubmit={handleSubmit} className="space-y-4">
              
              <div className="grid grid-cols-[1fr_200px] gap-6">
                
                {/* LEFT STACK (Name → Symbol → Decimals → Supply) */}
                <div ref={leftColRef}>
                  
                  <label className="mintx-label">Name</label>
                  <input className="mintx-input mb-4" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />

                  <label className="mintx-label">Symbol</label>
                  <input className="mintx-input mb-4" value={tokenSymbol} onChange={(e) => setTokenSymbol(e.target.value)} />

                  <label className="mintx-label">Decimals</label>
                  <input
                    className="mintx-input mb-4"
                    type="number"
                    min="0"
                    max="9"
                    value={decimals}
                    onChange={(e) => setDecimals(e.target.value)}
                  />

                  <label className="mintx-label">Supply</label>
                  <input
                    className="mintx-input mb-4"
                    value={initialSupply}
                    onChange={(e) => setInitialSupply(e.target.value)}
                  />

                </div>

                {/* RIGHT IMAGE BOX (Height auto matches left column) */}
                <div className="flex justify-center items-start">
                  <div
                    className="rounded-xl bg-[#091022] border border-white/5 flex items-center justify-center cursor-pointer"
                    style={{
                      width: 200,
                      height: imageBoxHeight,
                      transition: "height 0.2s ease",
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {/* circular inside */}
                    <div
                      className="rounded-full overflow-hidden flex items-center justify-center"
                      style={{
                        width: 140,
                        height: 140,
                        background: imagePreview ? "transparent" : "rgba(255,255,255,0.05)",
                      }}
                    >
                      {!imagePreview ? (
                        <svg className="w-8 h-8 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                      ) : (
                        <img src={imagePreview} className="w-full h-full object-cover" />
                      )}
                    </div>
                  </div>
                </div>

              </div>

              {/* FULL-WIDTH DESCRIPTION */}
              <label className="mintx-label">Description</label>
              <textarea
                className="mintx-input mintx-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />

              <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleImageChange} />

              {/* REVOKE TOGGLES (perfect orion style alignment) */}
              <div className="grid grid-cols-2 gap-4">

                <div className="p-4 rounded-xl bg-[#071029]">
                  <h3 className="text-sm font-semibold text-white">
                    Revoke Freeze <span className="text-xs text-gray-400">(required)</span>
                  </h3>
                  <p className="text-xs text-gray-400 mt-1">Allows creating a liquidity pool</p>

                  <div className="flex justify-between items-center mt-3">
                    <Switch
                      checked={revokeFreezeAuthority}
                      onChange={setRevokeFreezeAuthority}
                      className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                        revokeFreezeAuthority ? "bg-[#7C3AED]" : "bg-gray-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white transform transition-all duration-300 ${
                          revokeFreezeAuthority ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </Switch>
                    <span className="text-xs text-gray-300">(0.1 SOL)</span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#071029]">
                  <h3 className="text-sm font-semibold text-white">Revoke Mint</h3>
                  <p className="text-xs text-gray-400 mt-1">Prevents future minting</p>

                  <div className="flex justify-between items-center mt-3">
                    <Switch
                      checked={revokeMintAuthority}
                      onChange={setRevokeMintAuthority}
                      className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                        revokeMintAuthority ? "bg-[#7C3AED]" : "bg-gray-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white transform transition-all duration-300 ${
                          revokeMintAuthority ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </Switch>
                    <span className="text-xs text-gray-300">(0.1 SOL)</span>
                  </div>
                </div>

              </div>

              {/* SOCIAL TOGGLE */}
              <div className="p-4 rounded-xl bg-[#071029] flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-semibold text-white">Add Social Links</h3>
                  <p className="text-xs text-gray-400">Optional</p>
                </div>

                <Switch
                  checked={showSocials}
                  onChange={setShowSocials}
                  className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                    showSocials ? "bg-[#7C3AED]" : "bg-gray-700"
                  }`}
                >
                  <span className={`inline-block h-4 w-4 bg-white rounded-full transform ${showSocials ? "translate-x-6" : "translate-x-1"}`} />
                </Switch>
              </div>

              {showSocials && (
                <div className="grid grid-cols-2 gap-4">
                  {["website", "twitter", "telegram", "discord"].map((key) => (
                    <div key={key}>
                      <label className="mintx-label capitalize">{key}</label>
                      <input
                        className="mintx-input"
                        value={(socialLinks as any)[key]}
                        onChange={(e) => handleSocialChange(key as any, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              )}

              <ProgressIndicator />

              <button
                disabled={!publicKey || isLoading || !tokenImage}
                className="w-full py-3 rounded-lg font-medium bg-gradient-to-r from-[#7C3AED] to-[#EC4899] text-white disabled:opacity-50"
              >
                {!publicKey ? "Connect Wallet" : isLoading ? "Processing..." : "Create Token"}
              </button>

            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
