import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/** Local fixture: standard Java HTTPS over CONNECT, with one explicit CA and default hostname checks. */
public class JvmHttpsProbe {
    public static void main(String[] args) {
        try {
            if (args.length != 3) throw new IllegalArgumentException("Expected origin, proxy port and public CA file");
            URL url = new URL(args[0] + "/mobile-access/health");
            if (!"https".equals(url.getProtocol()) || !url.getHost().endsWith(".iroh.localhost")) {
                throw new IllegalArgumentException("Fixture origin must use identity HTTPS");
            }
            KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());
            trust.load(null);
            try (InputStream file = Files.newInputStream(Path.of(args[2]))) {
                trust.setCertificateEntry("isolated-host", CertificateFactory.getInstance("X.509").generateCertificate(file));
            }
            TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            factory.init(trust);
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, factory.getTrustManagers(), null);
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", Integer.parseInt(args[1])));
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection(proxy);
            connection.setSSLSocketFactory(context.getSocketFactory());
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(false);
            try {
                if (connection.getResponseCode() != 200) throw new IllegalStateException("Gateway health was rejected");
                try (InputStream body = connection.getInputStream()) {
                    byte[] bytes = body.readNBytes(4097);
                    if (bytes.length > 4096 || !new String(bytes, StandardCharsets.UTF_8).contains("\"ok\":true")) {
                        throw new IllegalStateException("Unexpected gateway health response");
                    }
                }
                System.out.println("JAVA_HTTPS_PROXY_PIN_OK");
            } finally {
                connection.disconnect();
            }
        } catch (Exception error) {
            System.err.println("JAVA_HTTPS_PROXY_FAILED:" + error.getClass().getSimpleName());
            System.exit(1);
        }
    }
}
