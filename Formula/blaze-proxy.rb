class BlazeProxy < Formula
  desc "Desktop AI model router - intercept model requests, serve from your own endpoint"
  homepage "https://github.com/KingJammin/blaze-proxy"
  url "https://github.com/KingJammin/blaze-proxy/archive/refs/tags/v0.3.1.tar.gz"
  sha256 "b647bae98dcd096578414ee8765a4b6b021653dbd16e3fc71dc65dff0ebb5b2e"
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
