const express = require('express');
const path = require('path');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const session = require('express-session');
const axios = require('axios');
const app = express();


// MySQL connection configuration
const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASS,
    database: process.env.DB_DBNAME
});
app.use(express.json());
app.use(session({
    secret: 'your-secret-key', 
    resave: false,
    saveUninitialized: true
}));

// Connect to MySQL
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL');
});

// Middleware
app.use(express.urlencoded({ extended: true }));

app.get('/api/products', (req, res) => {
    const { category, size } = req.query; 
    console.log('Fetching products for category:', category, 'and size:', size);
    let sql = 'SELECT * FROM products WHERE category = ?';
    const params = [category];

    if (size) {
        sql += ' AND size = ?';
        params.push(size);
    }

    connection.query(sql, params, (err, results) => {
        if (err) {
            console.error('Error fetching products:', err);
            res.status(500).send('Error fetching products');
            return;
        }
        console.log('Products fetched:', results);
        res.json(results); 
    });
});


app.get('/api/cart', (req, res) => {
    // Retrieve cart data from session (assuming you're storing cart data in the session)
    const cartData = req.session.cart || [];
    res.json(cartData);
}); 

const multer = require('multer');
const { report } = require('process');

// Set up multer storage and file naming
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, 'public/images'); // Specify the directory to save uploaded images
    },
    filename: function(req, file, cb) {
        cb(null, file.originalname); // Use the original file name
    }
});

//sales report

app.get('/api/sales-report', (req, res) => {
    const sql = `SELECT p.name, p.category, p.size, s.quantity, s.price, (s.quantity * s.price) AS total_amount, s.sale_date, s.is_refunded, c.username AS customer
                 FROM sales s
                 JOIN products p ON s.product_id = p.id
                 LEFT JOIN users c ON s.customer_id = c.id
                 ORDER BY s.sale_date DESC;`;

    connection.query(sql, (err, results) => {
        if (err) {
            console.error('Error fetching sales data:', err);
            return res.status(500).send('Error fetching sales data');
        }
        res.json(results);
    });
});



//refund a
app.post('/api/refund', (req, res) => {
    const { saleId } = req.body;

    if (!saleId) {
        return res.status(400).json({ message: 'Sale ID is required' });
    }

    connection.beginTransaction(err => {
        if (err) {
            console.error('Transaction Error:', err);
            return res.status(500).json({ message: 'Error starting transaction' });
        }

        // First, mark the original sale as refunded
        connection.query('UPDATE sales SET is_refunded = TRUE WHERE id = ? AND is_refunded = FALSE', [saleId], (err, updateResult) => {
            if (err || updateResult.affectedRows === 0) {
                connection.rollback(() => {
                    res.status(500).json({ message: 'Error updating refund status for the original sale or sale already refunded' });
                });
                return;
            }

            // Next, fetch details of the sale for refund processing
            connection.query('SELECT product_id, quantity, price, customer_id FROM sales WHERE id = ?', [saleId], (err, results) => {
                if (err || results.length === 0) {
                    connection.rollback(() => {
                        console.error('Error fetching sale:', err);
                        res.status(404).json({ message: 'Sale not found' });
                    });
                    return;
                }

                const { product_id, quantity, price, customer_id } = results[0];

                // Update the product stock
                connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [quantity, product_id], (err, result) => {
                    if (err) {
                        console.error('Error updating stock:', err);
                        connection.rollback(() => {
                            res.status(500).json({ message: 'Error updating product stock' });
                        });
                        return;
                    }

                    // Finally, insert a refund record into the sales table
                    connection.query('INSERT INTO sales (product_id, quantity, price, customer_id, transaction_type) VALUES (?, ?, ?, ?, ?)', 
                        [product_id, -quantity, price, customer_id, 'refund'], (err, result) => {
                        if (err) {
                            console.error('Error inserting refund record:', err);
                            connection.rollback(() => {
                                res.status(500).json({ message: 'Error inserting refund record' });
                            });
                            return;
                        }

                        // If all is good, commit the transaction
                        connection.commit(err => {
                            if (err) {
                                console.error('Transaction Commit Error:', err);
                                connection.rollback(() => {
                                    res.status(500).json({ message: 'Error during transaction commit' });
                                });
                                return;
                            }
                            res.json({ message: 'Refund processed successfully' });
                        });
                    });
                });
            });
        });
    });
});








const upload = multer({ storage: storage });

app.post('/admin/add-product', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    // Attempt to add the product...
    const { name, category, price, stock, size } = req.body;
    const imagePath = `/images/${req.file.filename}`; // Ensure file path handling is correct

    const sql = 'INSERT INTO products (name, category, price, stock, image, size) VALUES (?, ?, ?, ?, ?, ?)';
    connection.query(sql, [name, category, price, stock, imagePath, size], (err, result) => {
        if (err) {
            console.error('Error adding product:', err);
            return res.status(500).send('Server error while adding product');
        }
        res.send('Product added successfully');
    });
});

// Function to calculate the total amount of the order
function calculateTotalAmount(orderData) {
    let totalAmount = 0;
    for (const productId in orderData) {
        if (productId !== 'fullName' && productId !== 'address') {
            const quantityOrdered = orderData[productId];
            // Retrieve the product price from the database or from the order itself
            // For simplicity, let's assume the product price is directly available in the orderData
            const productPrice = getProductPrice(productId);
            totalAmount += quantityOrdered * productPrice;
        }
    }
    return totalAmount;
}


function checkLowStock() {
    const sql = 'SELECT id, stock FROM products WHERE stock <= ?';
    const lowStockThreshold = 5; // Set your threshold
    connection.query(sql, [lowStockThreshold], (err, results) => {
        if (err) {
            console.error('Error checking stock levels:', err);
            return;
        }
        results.forEach(product => {
            if (product.stock <= lowStockThreshold) {
                console.log(`Alert: Product ID ${product.id} is low on stock`);
                // Implement your notification logic here
            }
        });
    });
}
// Run checkLowStock every hour
setInterval(checkLowStock, 60000); // 60000 milliseconds = 1 minute

// Helper function to execute MySQL queries asynchronously
function queryAsync(sql, values) {
    return new Promise((resolve, reject) => {
        connection.query(sql, values, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}


app.post('/api/remove-from-cart', (req, res) => {
    const { productId } = req.body;
    if (!productId) {
        return res.status(400).send('Product ID is required');
    }

    // Assuming cart is stored in session
    req.session.cart = req.session.cart.filter(item => item.id.toString() !== productId.toString());
    console.log('Cart after removal:', req.session.cart);
    res.status(200).send('Item removed from cart');
});

// Add Product to Cart
app.post('/api/cart', (req, res) => {
    const { productId } = req.body;

    // Check if productId is provided
    if (!productId) {
        res.status(400).send('Product ID is required');
        return;
    }

    const sql = 'SELECT * FROM products WHERE id = ?';
    connection.query(sql, [productId], (err, results) => {
        if (err) {
            console.error('Error fetching product details:', err);
            res.status(500).send('Server error while fetching product details');
            return;
        }

        if (results.length === 0) {
            res.status(404).send('Product not found');
            return;
        }

        const product = results[0];
        req.session.cart = req.session.cart || [];
        
        // Find if the product is already in the cart
        let cartItem = req.session.cart.find(item => item.id === product.id);

        if (cartItem) {
            // Check stock before adding more
            if (cartItem.quantity < product.stock) {
                cartItem.quantity += 1;  // Increase quantity
            } else {
                return res.status(400).send('Not enough stock available');
            }
        } else {
            // If the product is not found in the cart, add it
            product.quantity = 1;
            req.session.cart.push(product);
        }

        console.log('Cart updated:', req.session.cart);
        res.status(200).send('Cart updated successfully');
    });
});


app.get('/api/search', (req, res) => {
    let searchQuery = req.query.query || '';
    let size = req.query.size;
    searchQuery = `%${searchQuery}%`;

    let sql = 'SELECT * FROM products WHERE name LIKE ?';
    let params = [searchQuery];

    if (size) {
        sql += ' AND size = ?';
        params.push(size);
    }

    connection.query(sql, params, (err, results) => {
        if (err) {
            console.error('Error fetching search results:', err);
            res.status(500).send('Error fetching search results');
            return;
        }
        res.json(results);
    });
});

app.get('/api/user-info', (req, res) => {
    // Check if the user's details are stored in the session
    if (req.session && req.session.user) {
        // User is logged in, send back the user info
        const userInfo = {
            id: req.session.user.id,
            username: req.session.user.username,
            email: req.session.user.email
            // Make sure not to send sensitive data like passwords
        };
        res.json(userInfo);
    } else {
        // User is not logged in, send a 401 Unauthorized response
        res.status(401).send('User not logged in');
    }
});

app.get('/account', (req, res) => {
    
    // Here, make sure to check if the user is logged in
    res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

app.get('/api/search', (req, res) => {
    let searchQuery = req.query.query || '';
    let size = req.query.size || '';
    searchQuery = `%${searchQuery}%`;
    let sql = 'SELECT * FROM products WHERE name LIKE ?';

    let params = [searchQuery];
    if (size) {
        sql += ' AND size = ?';
        params.push(size);
    }

    connection.query(sql, params, (err, results) => {
        if (err) {
            console.error('Error fetching search results:', err);
            res.status(500).send('Error fetching search results');
            return;
        }
        // Send back the results to the client
        res.json(results);
    });
});



// Edit Product
app.post('/admin/edit-product', (req, res) => {
    const { id, name, category, price, stock } = req.body;
    const sql = 'UPDATE products SET name = ?, category = ?, price = ?, stock = ? WHERE id = ?';
    connection.query(sql, [name, category, price, stock, id], (err, result) => {
        if (err) {
            console.error('Error editing product:', err);
            res.status(500).send('Server error while editing product');
            return;
        }
        res.send('Product edited successfully');
    });
});

// Delete Product
app.post('/admin/delete-product', (req, res) => {
    const { id } = req.body;
    const sql = 'DELETE FROM products WHERE id = ?';
    connection.query(sql, [id], (err, result) => {
        if (err) {
            console.error('Error deleting product:', err);
            res.status(500).send('Server error while deleting product');
            return;
        }
        res.send('Product deleted successfully');
    });
});

app.get('/api/low-stock-products', (req, res) => {
    const lowStockThreshold = 5; // Set your threshold
    const sql = 'SELECT id, name, stock FROM products WHERE stock <= ?';

    connection.query(sql, [lowStockThreshold], (err, results) => {
        if (err) {
            console.error('Error fetching low stock products:', err);
            res.status(500).send('Error fetching low stock products');
            return;
        }
        res.json(results);
    });
});

// Route to serve login.html (place before static middleware)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/logout', (req, res) => {
    // Destroy the session to log the user out
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
            res.status(500).send('Server Error');
            return;
        }
        // Redirect the user to the login page after logout
        res.redirect('/login.html');
    });
});






app.get('/api/order-history', (req, res) => {
    const customerId = req.session.user.id;
    const sql = `SELECT sales.id, sales.sale_date, products.name, sales.quantity, sales.price, sales.is_refunded 
                FROM sales 
                JOIN products ON sales.product_id = products.id 
                WHERE sales.customer_id = ? 
                ORDER BY sales.sale_date DESC`;
    connection.query(sql, [customerId], (err, results) => {
        if (err) {
            console.error('Error fetching order history:', err);
            res.status(500).send('Error fetching order history');
            return;
        }
        res.json(results);
    });
});


// Serve static files (HTML, CSS, JavaScript)
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.post('/api/checkout', (req, res) => {
    const cartItems = req.session.cart || [];

    // Start a database transaction
    connection.beginTransaction(err => {
        if (err) {
            console.error('Transaction Error:', err);
            return res.status(500).send('Error starting transaction');
        }

        const processCartItem = (index) => {
            if (index >= cartItems.length) {
                // All items processed, commit transaction
                connection.commit(err => {
                    if (err) {
                        console.error('Transaction Commit Error:', err);
                        connection.rollback();
                        return res.status(500).send('Error during transaction commit');
                    }

                    // Clear the cart
                    req.session.cart = [];

                    // Record the sale in the sales table
                    recordSales(cartItems, req.session.user.id, () => {
                        return res.send('Checkout successful');
                    });
                });
                return;
            }

            const item = cartItems[index];
            const updateSql = 'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?';

            connection.query(updateSql, [item.quantity, item.id, item.quantity], (err, result) => {
                if (err || result.affectedRows === 0) {
                    console.error('Error updating product or insufficient stock:', err);
                    connection.rollback();
                    return res.status(500).send('Error updating product or insufficient stock');
                }
                // Process next item
                processCartItem(index + 1);
            });
        };

        processCartItem(0);
    });
});

function recordSales(cartItems, customerId, callback) {
    let salesRecorded = 0;
    cartItems.forEach(item => {
        const saleSql = 'INSERT INTO sales (product_id, quantity, price, customer_id, sale_date) VALUES (?, ?, ?, ?, NOW())';
        connection.query(saleSql, [item.id, item.quantity, item.price, customerId], (err, result) => {
            if (err) {
                console.error('Error recording sale:', err);
                return;
            }
            salesRecorded++;
            if (salesRecorded === cartItems.length) {
                callback(); // Call the callback when all sales are recorded
            }
        });
    });
}

// Signup route
app.post('/signup', (req, res) => {
    const { username, email, password } = req.body;
    
    // Hash the password
    bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
            console.error('Error hashing password:', err);
            res.status(500).send('Server Error');
            return;
        }
        
        // Store the hashed password in the database
        const sql = `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`;
        connection.query(sql, [username, email, hash], (err, result) => {
            if (err) {
                console.error('Error signing up:', err);
                res.status(500).send('Server Error');
                return;
            }
            console.log('User signed up successfully:', result);
            res.redirect('/login.html'); // Redirect to login page after signup
        });
    });
});

// Admin login route
app.post('/admin-login', (req, res) => {
    const { adminUsername, adminPassword } = req.body;
    // Replace 'admin' and 'adminpass' with your actual admin username and password
    if (adminUsername === 'admin' && adminPassword === 'adminpass') {
        console.log('Admin login successful');
        res.redirect('/admin.html'); // Redirect to the admin portal page
    } else {
        res.status(401).send('Invalid admin username or password');
    }
});


app.post('/api/complete-sale', (req, res) => {
    const cartItems = req.body.cartItems;
    
    if (!Array.isArray(cartItems)) {
        return res.status(400).send('Invalid cart items data');
    }

    cartItems.forEach(item => {
        const sql = 'INSERT INTO sales (product_id, quantity, price, customer_id) VALUES (?, ?, ?, ?)';
        connection.query(sql, [item.productId, item.quantity, item.price, item.customerId], (err, result) => {
            if (err) {
                console.error('Error recording sale:', err);
                return res.status(500).send('Error recording sale');
            }
        });
    });

    res.send('Sale recorded successfully');
});

// Login route
app.post('/user-login', (req, res) => {
    const { username, password } = req.body;

    // Replace this SQL query with the appropriate one for your database schema
    const sql = 'SELECT * FROM users WHERE username = ?';
    connection.query(sql, [username], (err, result) => {
        if (err) {
            console.error('Error logging in:', err);
            res.status(500).send('Server Error');
            return;
        }

        if (result.length === 0) {
            res.status(401).send('Invalid username or password');
            return;
        }

        const hashedPassword = result[0].password;

        bcrypt.compare(password, hashedPassword, (err, match) => {
            if (err) {
                console.error('Error comparing passwords:', err);
                res.status(500).send('Server Error');
                return;
            }

            if (!match) {
                res.status(401).send('Invalid username or password');
                return;
            }

            // On successful login, store user details in the session
            req.session.user = {
                id: result[0].id,
                username: result[0].username,
                email: result[0].email
                // Exclude sensitive data like password
            };

            console.log('Login successful:', req.session.user);
            res.redirect('/index.html');
        });
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
