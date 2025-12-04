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
import { useRef, useState, useEffect } from "react";

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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateProgress = (status: UploadProgress["status"], message: string, progress = 0) => {
    setUploadProgress({ status, message, progress });
  };

  const handleImageChange = (e: any) => {
    if (e.target.files?.[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) return alert("Image too large");
      setTokenImage(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const handleSocialChange = (key: keyof SocialLinks, v: string) => {
    setSocialLinks((p) => ({ ...p, [key]: v }));
  };

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (!publicKey) return alert("Connect wallet");
    if (!tokenImage) return alert("Upload image");

    const dec = Number(decimals);
    if (dec < 0 || dec > 9) return alert("Decimals 0–9 only");
    if (!initialSupply || Number(initialSupply) <= 0) return alert("Bad supply");

    const mintAmount = BigInt(Number(initialSupply) * Math.pow(10, dec));

    try {
      setIsLoading(true);
      updateProgress("uploading", "Processing fee...", 10);

      const totalFee =
        BASE_FEE +
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

      const uploaded = await umi.uploader.upload([file]);
      const imageUrl = uploaded[0];

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
      const user = toPublicKey(publicKey.toBase58());

      await createMintWithAssociatedToken(umi, {
        mint: mintKeypair,
        owner: user,
        amount: mintAmount,
        decimals: dec,
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
        decimals: dec,
        creators: some([{ address: umi.identity.publicKey, share: 100, verified: true }]),
        collection: none(),
        uses: none(),
        isMutable: true,
      }).sendAndConfirm(umi);

      const tokenAcc = findAssociatedTokenPda(umi, {
        mint: mintKeypair.publicKey,
        owner: user,
      });

      setTokenData({
        mint: mintKeypair.publicKey.toString(),
        metadata: metadataUri,
        tokenAddress: tokenAcc.toString(),
      });

      updateProgress("done", "Token created!", 100);
    } catch (err) {
      console.error(err);
      updateProgress("error", "Error creating token", 0);
    }
    setIsLoading(false);
  };

  const ProgressIndicator = () => {
    if (uploadProgress.status === "idle") return null;
    const bg =
      uploadProgress.status === "done"
        ? "bg-green-500"
        : uploadProgress.status === "error"
        ? "bg-red-500"
        : "bg-[#7C3AED]";

    return (
      <div className="mt-3">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-300">{uploadProgress.message}</span>
          <span className="text-gray-400">{uploadProgress.progress}%</span>
        </div>
        <div className="w-full h-2 bg-black/50 rounded-full">
          <div className={`h-2 rounded-full ${bg}`} style={{ width: `${uploadProgress.progress}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex justify-center p-6">
      <div className="w-full max-w-[520px]">
        <div className="mintx-card relative">
          <div className="mintx-gradient-border" />

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

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* ========================================= */}
            {/* EXACT FORM LAYOUT: NAME + SYMBOL same row */}
            {/* ========================================= */}
            <div className="grid grid-cols-2 gap-4">

              {/* NAME */}
              <div>
                <label className="mintx-label">Name</label>
                <input className="mintx-input" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
              </div>

              {/* SYMBOL */}
              <div>
                <label className="mintx-label">Symbol</label>
                <input className="mintx-input" value={tokenSymbol} onChange={(e) => setTokenSymbol(e.target.value)} />
              </div>

            </div>

            {/* ========================================= */}
            {/* EXACT: LEFT (Decimals + Supply)   RIGHT (Image full height) */}
            {/* ========================================= */}
            <div className="grid grid-cols-2 gap-4">

              {/* LEFT COLUMN STACK */}
              <div className="flex flex-col space-y-4">

                <div>
                  <label className="mintx-label">Decimals</label>
                  <input className="mintx-input" value={decimals} onChange={(e) => setDecimals(e.target.value)} />
                </div>

                <div>
                  <label className="mintx-label">Supply</label>
                  <input className="mintx-input" value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} />
                </div>

              </div>

              {/* RIGHT COLUMN IMAGE — FULL HEIGHT MATCH */}
              <div className="flex justify-center items-stretch">
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="cursor-pointer rounded-xl bg-[#0b0f1a] border border-white/10 flex justify-center items-center w-full"
                  style={{
                    minHeight: "100%", // auto-stretches to match left height
                  }}
                >
                  {!imagePreview ? (
                    <div className="w-28 h-28 rounded-full bg-[#111827] flex items-center justify-center opacity-40">
                      <span className="text-3xl text-white/40">+</span>
                    </div>
                  ) : (
                    <img
                      src={imagePreview}
                      style={{
                        width: "125px",
                        height: "125px",
                        borderRadius: "9999px",
                        objectFit: "cover",
                      }}
                    />
                  )}
                </div>
              </div>
            </div>

            <input ref={fileInputRef} type="file" className="hidden" accept="image/*" onChange={handleImageChange} />

            {/* DESCRIPTION */}
            <div>
              <label className="mintx-label">Description</label>
              <textarea className="mintx-input mintx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            {/* REVOKE FREEZE + REVOKE MINT */}
            <div className="grid grid-cols-2 gap-4">
              <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029]">
                <h3 className="text-sm font-semibold text-white">
                  Revoke Freeze <span className="text-xs text-gray-400">(required)</span>
                </h3>
                <p className="text-xs text-gray-400 mt-1">Revoke Freeze allows you to create a liquidity pool</p>
                <div className="flex justify-between items-center mt-3">
                  <Switch
                    checked={revokeFreezeAuthority}
                    onChange={setRevokeFreezeAuthority}
                    className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                      revokeFreezeAuthority ? "bg-teal-400" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 bg-white rounded-full transform transition-all ${
                        revokeFreezeAuthority ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </Switch>
                  <span className="text-xs text-gray-300">(0.0123 SOL)</span>
                </div>
              </div>

              <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029]">
                <h3 className="text-sm font-semibold text-white">Revoke Mint</h3>
                <p className="text-xs text-gray-400 mt-1">Mint Authority allows you to increase tokens supply</p>
                <div className="flex justify-between items-center mt-3">
                  <Switch
                    checked={revokeMintAuthority}
                    onChange={setRevokeMintAuthority}
                    className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                      revokeMintAuthority ? "bg-purple-600" : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 bg-white rounded-full transform transition-all ${
                        revokeMintAuthority ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </Switch>
                  <span className="text-xs text-gray-300">(0.0123 SOL)</span>
                </div>
              </div>
            </div>

            {/* SOCIAL LINKS */}
            <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029] flex justify-between items-center">
              <div>
                <h3 className="text-sm font-semibold text-white">Add Social Links</h3>
                <p className="text-xs text-gray-400">Optional but recommended</p>
              </div>
              <Switch
                checked={showSocials}
                onChange={setShowSocials}
                className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                  showSocials ? "bg-[#7C3AED]" : "bg-gray-700"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 bg-white rounded-full transform transition-all ${
                    showSocials ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </Switch>
            </div>

            {showSocials && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mintx-label">Website</label>
                  <input className="mintx-input" value={socialLinks.website} onChange={(e) => handleSocialChange("website", e.target.value)} />
                </div>
                <div>
                  <label className="mintx-label">Twitter</label>
                  <input className="mintx-input" value={socialLinks.twitter} onChange={(e) => handleSocialChange("twitter", e.target.value)} />
                </div>
                <div>
                  <label className="mintx-label">Telegram</label>
                  <input className="mintx-input" value={socialLinks.telegram} onChange={(e) => handleSocialChange("telegram", e.target.value)} />
                </div>
                <div>
                  <label className="mintx-label">Discord</label>
                  <input className="mintx-input" value={socialLinks.discord} onChange={(e) => handleSocialChange("discord", e.target.value)} />
                </div>
              </div>
            )}

            <ProgressIndicator />

            <button
              type="submit"
              disabled={!publicKey || isLoading || !tokenImage}
              className="mintx-submit w-full mt-2 py-3 bg-gradient-to-r from-[#7C3AED] to-[#EC4899] rounded-lg text-white text-sm font-medium"
            >
              {!publicKey ? "Connect Wallet" : isLoading ? "Processing..." : "Create Token"}
            </button>
          </form>

          {tokenData && (
            <div className="mintx-small-box mt-4 p-3 rounded-lg bg-[#071029]">
              <h3
                className="text-lg font-semibold mb-2"
                style={{
                  background: "linear-gradient(90deg,#7C3AED,#EC4899)",
                  WebkitBackgroundClip: "text",
                  color: "transparent",
                }}
              >
                Token Created Successfully!
              </h3>
              <div className="space-y-2">
                <div>
                  <label className="mintx-label">Mint Address</label>
                  <div className="bg-[#0b1230] p-2 rounded-md text-sm text-gray-300 break-all">{tokenData.mint}</div>
                </div>
                <div>
                  <label className="mintx-label">Metadata URI</label>
                  <div className="bg-[#0b1230] p-2 rounded-md text-sm text-gray-300 break-all">{tokenData.metadata}</div>
                </div>
              </div>
            </div>
          )}

          <div className="mintx-small-box mt-3 text-center p-3 bg-[#071029] rounded-lg">
            Total Cost:{" "}
            {(
              BASE_FEE +
              (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
              (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)
            ).toFixed(3)}{" "}
            SOL
          </div>
        </div>
      </div>
    </div>
  );
}
