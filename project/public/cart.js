
$(document).ready(function() {
    $('#checkout-btn').click(function() {
        handlePurchase();
    });
    $('#cart-items').on('click', '.remove-from-cart-btn', function() {
        const productId = $(this).data('product-id');
        removeFromCart(productId);
    });
});
function handlePurchase() {
    $.ajax({
        url: '/api/checkout',
        method: 'POST',
        success: function(response) {
            alert('Purchase completed successfully!');
            // Handle post-purchase UI updates here
        },
        error: function(error) {
            console.error('Error during purchase:', error);
            alert('Could not complete the purchase. Please try again.');
        }
    });
}

function removeFromCart(productId) {
    $.ajax({
        url: '/api/remove-from-cart',
        method: 'POST',
        data: { productId: productId },
        success: function(response) {
            alert('Item removed successfully!');
            loadCart(); // Reload cart to update the UI
        },
        error: function(error) {
            console.error('Error removing item:', error);
            alert('Could not remove the item. Please try again.');
        }
    });
}


function loadCart() {
    $.ajax({
        url: '/api/cart',
        cache: false,  // Add this to bypass cache
        type: 'GET',
        success: function(cartData) {
            renderCart(cartData);
        },
        error: function(xhr, textStatus, errorThrown) {
            alert('Error fetching cart data');
        }
    });
}