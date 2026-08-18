class BlazeProxy < Formula
  desc "Desktop AI model router - intercept model requests, serve from your own endpoint"
  homepage "https://github.com/KingJammin/blaze-proxy"
  url "https://github.com/KingJammin/blaze-proxy/archive/refs/tags/v0.4.0.tar.gz"
  sha256 "c9f16d326efa71ca198bb984063a83a1195768c6ca0135b1e5a0d04c388da9cb"
  license "MIT"

  depends_on "node"

  def install
    # Headless install: the Electron UI is an optional dependency; machines
    # that want it can run `npm install -g electron` or use the npm channel.
    system "npm", "install", *std_npm_args, "--omit=optional"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"blaze-proxy", "start"]
    keep_alive true
    log_path var/"log/blaze-proxy.log"
    error_log_path var/"log/blaze-proxy.error.log"
  end

  test do
    assert_match "usage: blaze-proxy", shell_output("#{bin}/blaze-proxy help 2>&1", 1)
  end
end
